import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HumanGateRequestSchema } from '../../../../../shared/human-gate-contract'
import { OrchestrationDb } from '../orchestration-db'
import { recordHumanGateDecision, expireHumanGate } from './human-gate-decision'
import { humanGateFixture, openHumanGate, ownerAuthority } from './human-gate-test-fixture'
import { requireHumanGateRecord } from './human-gate-record'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
  vi.useRealTimers()
})

describe('native typed Human Gate authority', () => {
  it('opts in through the existing gate authority and binds exact request facts', () => {
    const request = humanGateFixture(db)
    const gate = openHumanGate(db, request)
    expect(gate.request).toEqual(request)
    expect(gate.request_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(gate.state).toBe('pending')
    expect(db.getTask(request.identity.task_id)?.status).toBe('blocked')
    expect(db.getGate(gate.gate_id)?.status).toBe('pending')
    expect(gate.receipt).toBeNull()
  })

  it('rejects incomplete or unknown contract fields and abbreviated PR heads', () => {
    const request = humanGateFixture(db)
    expect(HumanGateRequestSchema.safeParse({ ...request, allows: [] }).success).toBe(false)
    expect(
      HumanGateRequestSchema.safeParse({ ...request, does_not_allow: undefined }).success
    ).toBe(false)
    expect(
      HumanGateRequestSchema.safeParse({ ...request, principal: ownerAuthority() }).success
    ).toBe(false)
    expect(
      HumanGateRequestSchema.safeParse({
        ...request,
        subject: { ...request.subject, head_sha: 'abc123' }
      }).success
    ).toBe(false)
    expect(
      HumanGateRequestSchema.safeParse({ ...request, source: { system: 'core' } }).success
    ).toBe(false)
  })

  it('atomically rejects wrong native Run/Task/Dispatch identities and legacy Runs', () => {
    const request = humanGateFixture(db)
    const other = humanGateFixture(db)
    expect(() =>
      openHumanGate(db, {
        ...request,
        identity: { ...request.identity, run_id: other.identity.run_id }
      })
    ).toThrow('exact native')
    expect(() =>
      openHumanGate(db, {
        ...request,
        requester: { ...request.requester, dispatch_id: 'unknown-dispatch' }
      })
    ).toThrow('Dispatch identity')
    const legacyTask = db.createTask({ runId: 'run_legacy_local', spec: 'legacy' })
    expect(() =>
      openHumanGate(db, {
        ...request,
        identity: { ...request.identity, run_id: legacyTask.run_id, task_id: legacyTask.id }
      })
    ).toThrow('exact native')
    expect(db.listGates()).toEqual([])
    expect(db.getTask(request.identity.task_id)?.status).toBe('ready')
  })

  it.each(['approved', 'rejected'] as const)(
    'writes a typed %s receipt exactly once without task execution',
    (decision) => {
      const request = humanGateFixture(db)
      const gate = openHumanGate(db, request)
      const command = {
        gate_id: gate.gate_id,
        request_fingerprint: gate.request_fingerprint,
        decision
      }
      const authority = vi.fn(ownerAuthority)
      const receipt = recordHumanGateDecision(db.db, command, authority)
      expect(authority).toHaveBeenCalledWith(command, gate)
      expect(receipt.principal).toEqual(ownerAuthority())
      expect(receipt.receipt_fingerprint).toMatch(/^[0-9a-f]{64}$/)
      const changes = db.db.prepare('SELECT total_changes() AS count').get()
      expect(recordHumanGateDecision(db.db, command, authority)).toEqual(receipt)
      expect(db.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes)
      expect(requireHumanGateRecord(db.db, gate.gate_id).state).toBe(decision)
      expect(db.getTask(request.identity.task_id)?.status).toBe('blocked')
      expect(db.getGate(gate.gate_id)?.resolution).toBeNull()
      expect(() =>
        recordHumanGateDecision(
          db.db,
          { ...command, decision: decision === 'approved' ? 'rejected' : 'approved' },
          authority
        )
      ).toThrow('different owner decision')
      expect(() =>
        recordHumanGateDecision(db.db, command, () => ({
          ...ownerAuthority(),
          subject_id: 'someone-else'
        }))
      ).toThrow('different owner decision')
    }
  )

  it('rejects prose, payload principals, unauthenticated authority, and the wrong fingerprint', () => {
    const gate = openHumanGate(db, humanGateFixture(db))
    const command = {
      gate_id: gate.gate_id,
      request_fingerprint: gate.request_fingerprint,
      decision: 'approved' as const
    }
    const spoofed = { ...command, principal: ownerAuthority() }
    expect(() => recordHumanGateDecision(db.db, spoofed, ownerAuthority)).toThrow()
    expect(() =>
      recordHumanGateDecision(db.db, command, () => {
        throw new Error('Unauthenticated')
      })
    ).toThrow('Unauthenticated')
    expect(() =>
      recordHumanGateDecision(
        db.db,
        { ...command, request_fingerprint: '0'.repeat(64) },
        ownerAuthority
      )
    ).toThrow('fingerprint mismatch')
    expect(() => db.resolveGate(gate.gate_id, 'reviewer APPROVE: approved')).toThrow(
      'Typed Human Gate'
    )
    expect(() => db.timeoutGate(gate.gate_id)).toThrow('Typed Human Gate')
    expect(requireHumanGateRecord(db.db, gate.gate_id).receipt).toBeNull()
  })

  it('keeps immutable request, receipt and native identity under SQL updates, replacement and deletion', () => {
    const gate = openHumanGate(db, humanGateFixture(db))
    recordHumanGateDecision(
      db.db,
      {
        gate_id: gate.gate_id,
        request_fingerprint: gate.request_fingerprint,
        decision: 'approved'
      },
      ownerAuthority
    )
    for (const table of ['human_gate_requests', 'human_gate_receipts']) {
      expect(() => db.db.prepare(`UPDATE ${table} SET gate_id = gate_id`).run()).toThrow(
        'immutable'
      )
      expect(() => db.db.prepare(`DELETE FROM ${table}`).run()).toThrow('immutable')
      expect(() =>
        db.db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run()
      ).toThrow('immutable')
    }
    expect(() =>
      db.db
        .prepare('UPDATE decision_gates SET question = ? WHERE id = ?')
        .run('new scope', gate.gate_id)
    ).toThrow('Typed Human Gate')
    expect(() =>
      db.db.exec('INSERT OR REPLACE INTO decision_gates SELECT * FROM decision_gates')
    ).toThrow('immutable')
    expect(() =>
      db.db
        .prepare('UPDATE tasks SET run_id = ? WHERE id = ?')
        .run('changed', gate.request.identity.task_id)
    ).toThrow('immutable')
    expect(() => db.resetTasks()).toThrow('immutable')
    expect(() => db.resetAll()).toThrow('immutable')
    expect(requireHumanGateRecord(db.db, gate.gate_id).state).toBe('approved')
  })

  it('rejects request replacement through the unique fingerprint on a different gate ID', () => {
    const request = humanGateFixture(db)
    const gate = openHumanGate(db, request)
    const other = db.createGate({ taskId: request.identity.task_id, question: request.reason })
    db.db.pragma('recursive_triggers = OFF')
    expect(() =>
      db.db
        .prepare(`INSERT OR REPLACE INTO human_gate_requests
      SELECT ?, run_id, task_id, identity_json, request_json, request_fingerprint
      FROM human_gate_requests WHERE gate_id = ?`)
        .run(other.id, gate.gate_id)
    ).toThrow('immutable')
    expect(requireHumanGateRecord(db.db, gate.gate_id)).toEqual(gate)
    expect(() => db.resolveGate(gate.gate_id, 'approved')).toThrow('Typed Human Gate')
    expect(db.resolveGate(other.id, 'legacy result')?.status).toBe('resolved')
  })

  it('never downgrades invalid explicit typed opt-in to a legacy gate', () => {
    const request = humanGateFixture(db)
    for (const humanGate of [null, false, '']) {
      expect(() =>
        (
          db.createGate as unknown as (input: {
            taskId: string
            question: string
            humanGate: unknown
          }) => unknown
        )({ taskId: request.identity.task_id, question: request.reason, humanGate })
      ).toThrow()
    }
    expect(db.listGates()).toEqual([])
  })

  it('supersedes approved requests atomically when the exact PR head or scope changes', () => {
    const request = humanGateFixture(db)
    const first = openHumanGate(db, request)
    const command = {
      gate_id: first.gate_id,
      request_fingerprint: first.request_fingerprint,
      decision: 'approved' as const
    }
    const receipt = recordHumanGateDecision(db.db, command, ownerAuthority)
    const next = openHumanGate(db, {
      ...request,
      revision: 2,
      scope: 'a different bounded operation',
      subject: {
        kind: 'pull_request',
        provider: 'gitlab',
        repository: 'example/orca',
        number: 81,
        head_sha: 'b'.repeat(40)
      },
      supersedes: { gate_id: first.gate_id, request_fingerprint: first.request_fingerprint }
    })
    expect(next.request_fingerprint).not.toBe(first.request_fingerprint)
    expect(next.state).toBe('pending')
    expect(next.receipt).toBeNull()
    const old = requireHumanGateRecord(db.db, first.gate_id)
    expect(old.state).toBe('superseded')
    expect(old.receipt).toEqual(receipt)
    expect(old.retirement?.successor?.gate_id).toBe(next.gate_id)
    expect(recordHumanGateDecision(db.db, command, ownerAuthority)).toEqual(receipt)
    expect(() =>
      recordHumanGateDecision(db.db, { ...command, gate_id: next.gate_id }, ownerAuthority)
    ).toThrow('fingerprint mismatch')
    expect(() => openHumanGate(db, { ...request, revision: 2, supersedes: command })).toThrow()
  })

  it('cannot supersede across registrations, products, tasks or revisions', () => {
    const request = humanGateFixture(db)
    const first = openHumanGate(db, request)
    const successor = {
      ...request,
      revision: 2,
      supersedes: { gate_id: first.gate_id, request_fingerprint: first.request_fingerprint }
    }
    for (const field of [
      'registration_id',
      'canonical_product',
      'mission_id',
      'contract_id'
    ] as const) {
      expect(() =>
        openHumanGate(db, { ...successor, identity: { ...request.identity, [field]: 'foreign' } })
      ).toThrow('supersession')
    }
    expect(() => openHumanGate(db, { ...successor, revision: 3 })).toThrow('revision conflict')
    expect(db.listGates()).toHaveLength(1)
    expect(requireHumanGateRecord(db.db, first.gate_id).state).toBe('pending')
  })

  it('records explicit expiry without losing receipts and refuses late decisions', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-01-01T00:00:00.000Z')
    const request = { ...humanGateFixture(db), expires_at: '2026-01-02T00:00:00.000Z' }
    const gate = openHumanGate(db, request)
    const reference = { gate_id: gate.gate_id, request_fingerprint: gate.request_fingerprint }
    expect(() => expireHumanGate(db.db, reference)).toThrow('not reached')
    vi.setSystemTime('2026-01-02T00:00:00.000Z')
    expect(() =>
      recordHumanGateDecision(db.db, { ...reference, decision: 'approved' }, ownerAuthority)
    ).toThrow('expired')
    expect(requireHumanGateRecord(db.db, gate.gate_id).state).toBe('pending')
    const retired = expireHumanGate(db.db, reference)
    expect(expireHumanGate(db.db, reference)).toEqual(retired)
    expect(requireHumanGateRecord(db.db, gate.gate_id).state).toBe('expired')
    expect(() => db.db.exec('DELETE FROM human_gate_retirements')).toThrow('immutable')
  })

  it('rolls back the request and supersession if the existing task lifecycle fails', () => {
    const request = humanGateFixture(db)
    const first = openHumanGate(db, request)
    db.db.exec(`CREATE TRIGGER force_human_gate_failure BEFORE UPDATE ON tasks
      BEGIN SELECT RAISE(ABORT, 'injected task failure'); END`)
    expect(() =>
      openHumanGate(db, {
        ...request,
        revision: 2,
        supersedes: { gate_id: first.gate_id, request_fingerprint: first.request_fingerprint }
      })
    ).toThrow('injected')
    expect(db.listGates()).toHaveLength(1)
    expect(requireHumanGateRecord(db.db, first.gate_id).retirement).toBeNull()
  })
})
