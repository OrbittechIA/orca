import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { readHumanGates } from './human-gate-projection'
import { humanGateFixture, openHumanGate, ownerAuthority } from './human-gate-test-fixture'
import { recordHumanGateDecision, expireHumanGate } from './human-gate-decision'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

describe('Core #81 native read representation', () => {
  it('distinguishes complete empty, partial legacy/truncated, and unavailable sources', () => {
    const request = humanGateFixture(db)
    expect(readHumanGates(db.db, request.identity)).toMatchObject({
      coverage: 'complete',
      gates: [],
      reasons: []
    })
    const missing = { ...request.identity, task_id: 'missing' }
    expect(readHumanGates(db.db, missing)).toMatchObject({
      coverage: 'unavailable',
      reasons: ['identity_not_found']
    })
    db.createGate({ taskId: request.identity.task_id, question: 'old prose approved' })
    expect(readHumanGates(db.db, request.identity)).toMatchObject({
      coverage: 'partial',
      reasons: ['legacy_gates'],
      gates: []
    })
    openHumanGate(db, request)
    openHumanGate(db, request)
    const truncated = readHumanGates(db.db, request.identity, 1)
    expect(truncated.coverage).toBe('partial')
    expect(truncated.reasons).toEqual(['legacy_gates', 'truncated'])
    expect(truncated.gates).toHaveLength(1)
    const old = new Database(':memory:')
    try {
      expect(readHumanGates(old, request.identity)).toMatchObject({
        coverage: 'unavailable',
        reasons: ['unsupported_schema']
      })
    } finally {
      old.close()
    }
  })

  it('uses exact registration identity despite pointer rotation, parallel missions or matching slugs', () => {
    const request = humanGateFixture(db)
    const original = openHumanGate(db, request)
    for (const field of [
      'registration_id',
      'canonical_product',
      'mission_id',
      'contract_id'
    ] as const) {
      const identity = { ...request.identity, [field]: `another-${field}` }
      const other = openHumanGate(db, { ...request, identity })
      expect(readHumanGates(db.db, identity).gates.map((gate) => gate.gate_id)).toEqual([
        other.gate_id
      ])
    }
    const parallel = humanGateFixture(db)
    openHumanGate(db, parallel)
    const projected = readHumanGates(db.db, request.identity)
    expect(projected.gates).toEqual([original])
    expect(projected.gates[0]?.request.requested_at).toBe('2020-01-01T00:00:00.000Z')
    expect(projected.gates[0]?.request.source.version).toBe('source-commit-81')
    expect(readHumanGates(db.db, request.identity)).toEqual(projected)
  })

  it('keeps two gates on one PR independent and stable when multiple consumers read them', () => {
    const request = humanGateFixture(db)
    const first = openHumanGate(db, request)
    const second = openHumanGate(db, { ...request, scope: 'independent operation' })
    recordHumanGateDecision(
      db.db,
      {
        gate_id: first.gate_id,
        request_fingerprint: first.request_fingerprint,
        decision: 'approved'
      },
      ownerAuthority
    )
    const firstFront = readHumanGates(db.db, request.identity)
    const secondFront = readHumanGates(db.db, request.identity)
    expect(firstFront).toEqual(secondFront)
    expect(firstFront.gates.find((gate) => gate.gate_id === first.gate_id)?.state).toBe('approved')
    expect(firstFront.gates.find((gate) => gate.gate_id === second.gate_id)?.state).toBe('pending')
  })

  it('returns pending, approved/rejected, superseded and expired records without writes or acknowledgments', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-01-01T00:00:00.000Z')
    const request = { ...humanGateFixture(db), expires_at: '2026-01-02T00:00:00.000Z' }
    const approved = openHumanGate(db, request)
    const rejected = openHumanGate(db, request)
    for (const [gate, decision] of [
      [approved, 'approved'],
      [rejected, 'rejected']
    ] as const) {
      recordHumanGateDecision(
        db.db,
        { gate_id: gate.gate_id, request_fingerprint: gate.request_fingerprint, decision },
        ownerAuthority
      )
    }
    const pending = openHumanGate(db, request)
    const expired = openHumanGate(db, request)
    const superseded = openHumanGate(db, request)
    openHumanGate(db, {
      ...request,
      revision: 2,
      supersedes: {
        gate_id: superseded.gate_id,
        request_fingerprint: superseded.request_fingerprint
      }
    })
    vi.setSystemTime('2026-01-02T00:00:00.000Z')
    expireHumanGate(db.db, {
      gate_id: expired.gate_id,
      request_fingerprint: expired.request_fingerprint
    })
    const before = db.db.prepare('SELECT total_changes() AS changes').get()
    const writes = vi.spyOn(db.db, 'exec')
    const queries = vi.spyOn(db.db, 'prepare')
    db.db.pragma('query_only = ON')
    const first = readHumanGates(db.db, request.identity)
    expect(readHumanGates(db.db, request.identity)).toEqual(first)
    expect(first.coverage).toBe('complete')
    expect(first.gates.find((gate) => gate.gate_id === pending.gate_id)?.state).toBe('pending')
    expect(new Set(first.gates.map((gate) => gate.state))).toEqual(
      new Set(['pending', 'approved', 'rejected', 'superseded', 'expired'])
    )
    expect(writes).not.toHaveBeenCalled()
    expect(queries.mock.calls.every(([sql]) => /^SELECT\b/.test(sql))).toBe(true)
    expect(db.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
  })

  it('fails closed on malformed persisted evidence instead of inferring approval', () => {
    const request = humanGateFixture(db)
    const gate = openHumanGate(db, request)
    db.db.exec('DROP TRIGGER human_gate_requests_immutable_update')
    db.db
      .prepare(`UPDATE human_gate_requests SET request_fingerprint = ? WHERE gate_id = ?`)
      .run('0'.repeat(64), gate.gate_id)
    expect(readHumanGates(db.db, request.identity)).toMatchObject({
      coverage: 'partial',
      reasons: ['invalid_record'],
      gates: []
    })
  })

  it('reads through a caller-owned read-only connection without opening files or migrating', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-human-gate-read-'))
    const path = join(root, 'test.db')
    const writer = new OrchestrationDb(path)
    try {
      const request = humanGateFixture(writer)
      openHumanGate(writer, request)
      const reader = new Database(path, { readonly: true, fileMustExist: true })
      try {
        const bytes = readFileSync(path)
        const files = readdirSync(root)
        expect(readHumanGates(reader, request.identity).coverage).toBe('complete')
        expect(readFileSync(path)).toEqual(bytes)
        expect(readdirSync(root)).toEqual(files)
      } finally {
        reader.close()
      }
      const old = new Database(':memory:')
      try {
        old.pragma('user_version = 41')
        old.pragma('query_only = ON')
        expect(readHumanGates(old, request.identity).reasons).toEqual(['unsupported_schema'])
        expect(old.pragma('user_version', { simple: true })).toBe(41)
      } finally {
        old.close()
      }
      expect(readHumanGates(null, request.identity)).toMatchObject({
        coverage: 'unavailable',
        reasons: ['source_unavailable']
      })
    } finally {
      writer.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
