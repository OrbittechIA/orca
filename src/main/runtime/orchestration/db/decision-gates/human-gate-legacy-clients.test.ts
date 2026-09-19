import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { humanGateFixture, openHumanGate } from './human-gate-test-fixture'
import { requireHumanGateRecord } from './human-gate-record'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => db.close())

describe('legacy client operations around typed Human Gates', () => {
  it('keeps idempotent Run ensures working for ordinary terminal mail', () => {
    const request = humanGateFixture(db)
    const first = db.insertMessage({ from: 'term_one', to: 'term_two', subject: 'initial' })
    const task = db.createTask({ runId: first.run_id, spec: 'mail task' })
    const gate = openHumanGate(db, {
      ...request,
      identity: { ...request.identity, run_id: task.run_id, task_id: task.id }
    })
    const second = db.insertMessage({ from: 'term_one', to: 'term_two', subject: 'follow-up' })
    expect(second.run_id).toBe(first.run_id)
    expect(requireHumanGateRecord(db.db, gate.gate_id)).toEqual(gate)
  })

  it('keeps remote attachment Run ensures working without changing native authority', () => {
    const request = humanGateFixture(db)
    const gate = openHumanGate(db, request)
    const before = db.getRun(request.identity.run_id)
    const attachment = db.createRemoteDispatchAttachment({
      dispatchId: 'dispatch_remote',
      runId: request.identity.run_id,
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 1,
      runtimeEpoch: 'epoch',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'attach',
        method: 'attach',
        payloadHash: 'payload'
      }
    })
    expect(attachment.home_run_id).toBe(request.identity.run_id)
    expect(db.getRun(request.identity.run_id)).toEqual(before)
    expect(requireHumanGateRecord(db.db, gate.gate_id)).toEqual(gate)
  })

  it('preserves a typed Run when a downgraded client attempts replacement', () => {
    const request = humanGateFixture(db)
    openHumanGate(db, request)
    const before = db.getRun(request.identity.run_id)
    db.db.pragma('recursive_triggers = OFF')
    expect(
      db.db
        .prepare(`INSERT OR REPLACE INTO runs (id, objective)
      VALUES (?, 'replacement')`)
        .run(request.identity.run_id).changes
    ).toBe(0)
    expect(db.getRun(request.identity.run_id)).toEqual(before)
    expect(() =>
      db.db.prepare('UPDATE runs SET legacy = 1 WHERE id = ?').run(request.identity.run_id)
    ).toThrow('immutable')
    expect(() =>
      db.db.prepare('DELETE FROM runs WHERE id = ?').run(request.identity.run_id)
    ).toThrow('immutable')
  })
})
