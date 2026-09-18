import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import {
  humanGateFixture,
  openHumanGate,
  ownerAuthority
} from '../decision-gates/human-gate-test-fixture'
import { recordHumanGateDecision } from '../decision-gates/human-gate-decision'
import { readHumanGates } from '../decision-gates/human-gate-projection'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function testPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-human-gate-migrate-'))
  roots.push(root)
  return join(root, 'isolated.db')
}
function removeHumanGateSchema(db: Database.Database): void {
  const triggers = z
    .array(z.object({ name: z.string().regex(/^human_gate_[a-z_]+$/) }))
    .parse(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'human_gate_%'"
        )
        .all()
    )
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER ${name}`)
  }
  db.exec(
    'DROP TABLE human_gate_retirements; DROP TABLE human_gate_receipts; DROP TABLE human_gate_requests;'
  )
  db.pragma('user_version = 41')
}

describe('v42 Human Gate additive migration and recovery', () => {
  it('upgrades v41 with legacy rows intact and keeps old SQL clients working', () => {
    const path = testPath()
    const before = new OrchestrationDb(path)
    const request = humanGateFixture(before)
    const gate = before.createGate({
      taskId: request.identity.task_id,
      question: 'Legacy decision?'
    })
    removeHumanGateSchema(before.db)
    const baselineSchema = before.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
    before.close()
    const upgraded = new OrchestrationDb(path)
    try {
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(upgraded.getGate(gate.id)).toEqual(gate)
      for (const table of baselineSchema) {
        expect(
          upgraded.db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table.name)
        ).toEqual(table)
      }
      expect(upgraded.resolveGate(gate.id, 'legacy free text')?.status).toBe('resolved')
      const typed = openHumanGate(upgraded, request)
      const oldClient = new Database(path)
      try {
        const sql =
          "UPDATE decision_gates SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?"
        expect(() => oldClient.prepare(sql).run('APPROVE', typed.gate_id)).toThrow(
          'Typed Human Gate'
        )
        expect(oldClient.prepare(sql).run('still compatible', gate.id).changes).toBe(1)
        expect(
          oldClient.prepare('SELECT * FROM decision_gates WHERE task_id = ?').all(gate.task_id)
        ).toHaveLength(2)
      } finally {
        oldClient.close()
      }
    } finally {
      upgraded.close()
    }
  })

  it('rolls back an interrupted migration, then recovers without losing legacy state', () => {
    const db = new OrchestrationDb(testPath())
    try {
      const request = humanGateFixture(db)
      const gate = db.createGate({ taskId: request.identity.task_id, question: 'retained' })
      removeHumanGateSchema(db.db)
      const execute = db.db.exec.bind(db.db)
      const spy = vi.spyOn(db.db, 'exec').mockImplementation((sql) => {
        if (sql.includes('CREATE TABLE IF NOT EXISTS human_gate_requests')) {
          execute('CREATE TABLE human_gate_requests (gate_id TEXT PRIMARY KEY)')
          throw new Error('injected migration interruption')
        }
        execute(sql)
      })
      expect(() => db.migrate()).toThrow('injected migration interruption')
      expect(db.db.pragma('user_version', { simple: true })).toBe(41)
      expect(
        db.db.prepare("SELECT name FROM sqlite_master WHERE name = 'human_gate_requests'").get()
      ).toBeUndefined()
      expect(db.getGate(gate.id)).toEqual(gate)
      spy.mockRestore()
      db.migrate()
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      openHumanGate(db, request)
      expect(db.getGate(gate.id)).toEqual(gate)
    } finally {
      db.close()
    }
  })

  it('preserves typed evidence across downgrade SQL, reopen and identical receipt recovery', () => {
    const path = testPath()
    const first = new OrchestrationDb(path)
    const request = humanGateFixture(first)
    const gate = openHumanGate(first, request)
    const command = {
      gate_id: gate.gate_id,
      request_fingerprint: gate.request_fingerprint,
      decision: 'approved' as const
    }
    const receipt = recordHumanGateDecision(first.db, command, ownerAuthority)
    first.close()
    const oldClient = new Database(path)
    try {
      expect(oldClient.pragma('user_version', { simple: true })).toBe(42)
      expect(() =>
        oldClient
          .prepare("UPDATE decision_gates SET status = 'timeout' WHERE id = ?")
          .run(gate.gate_id)
      ).toThrow('Typed Human Gate')
      expect(() => oldClient.exec('DELETE FROM decision_gates')).toThrow('immutable')
    } finally {
      oldClient.close()
    }
    const recovered = new OrchestrationDb(path)
    try {
      expect(recordHumanGateDecision(recovered.db, command, ownerAuthority)).toEqual(receipt)
      expect(readHumanGates(recovered.db, request.identity).gates[0]?.receipt).toEqual(receipt)
      recovered.migrate()
    } finally {
      recovered.close()
    }
  })

  it('serializes competing receipt writers and returns the committed receipt on retry', () => {
    const path = testPath()
    const db = new OrchestrationDb(path)
    const second = new Database(path, { timeout: 0 })
    try {
      const gate = openHumanGate(db, humanGateFixture(db))
      const command = {
        gate_id: gate.gate_id,
        request_fingerprint: gate.request_fingerprint,
        decision: 'approved' as const
      }
      const receipt = recordHumanGateDecision(db.db, command, () => {
        expect(() =>
          recordHumanGateDecision(second, { ...command, decision: 'rejected' }, ownerAuthority)
        ).toThrow(/locked|busy/)
        return ownerAuthority()
      })
      expect(recordHumanGateDecision(second, command, ownerAuthority)).toEqual(receipt)
      expect(() =>
        recordHumanGateDecision(second, { ...command, decision: 'rejected' }, ownerAuthority)
      ).toThrow('different owner decision')
    } finally {
      second.close()
      db.close()
    }
  })

  it('rolls back failed receipt writes so recovery can record the same decision', () => {
    const db = new OrchestrationDb(testPath())
    try {
      const gate = openHumanGate(db, humanGateFixture(db))
      const command = {
        gate_id: gate.gate_id,
        request_fingerprint: gate.request_fingerprint,
        decision: 'rejected' as const
      }
      db.db.exec(`CREATE TRIGGER injected_receipt_failure AFTER INSERT ON human_gate_receipts
        BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)
      expect(() => recordHumanGateDecision(db.db, command, ownerAuthority)).toThrow(
        'injected receipt failure'
      )
      expect(readHumanGates(db.db, gate.request.identity).gates[0]?.receipt).toBeNull()
      db.db.exec('DROP TRIGGER injected_receipt_failure')
      expect(recordHumanGateDecision(db.db, command, ownerAuthority).decision).toBe('rejected')
    } finally {
      db.close()
    }
  })
})
