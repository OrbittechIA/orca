import { canonicalJson } from '../../../../../shared/canonical-json'
import {
  HumanGateRequestSchema,
  type HumanGateRetirement
} from '../../../../../shared/human-gate-contract'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { humanGateFingerprint } from './human-gate-fingerprint'
import { requireHumanGateRecord } from './human-gate-record'

export function persistHumanGateRequest(
  db: OrchestrationDb,
  gateId: string,
  taskId: string,
  question: string,
  input: unknown
): void {
  const request = HumanGateRequestSchema.parse(input)
  const task = db.getTask(taskId)
  const run = task && db.getRun(task.run_id)
  if (
    !run ||
    run.legacy ||
    taskId !== request.identity.task_id ||
    task?.run_id !== request.identity.run_id ||
    question !== request.reason
  ) {
    throw new OrchestrationError(
      'human_gate_identity_mismatch',
      'Human Gate must bind its exact native Run and Task'
    )
  }
  if (request.requester.dispatch_id) {
    const dispatch = db.getDispatchContextById(request.requester.dispatch_id)
    if (!dispatch || dispatch.task_id !== taskId || dispatch.run_id !== run.id) {
      throw new OrchestrationError(
        'human_gate_identity_mismatch',
        'Human Gate Dispatch identity mismatch'
      )
    }
  }
  const previous = request.supersedes && requireHumanGateRecord(db.db, request.supersedes.gate_id)
  if (previous) {
    if (
      previous.request_fingerprint !== request.supersedes?.request_fingerprint ||
      canonicalJson(previous.request.identity) !== canonicalJson(request.identity) ||
      request.revision !== previous.request.revision + 1 ||
      previous.retirement ||
      request.requested_at < previous.request.requested_at
    ) {
      throw new OrchestrationError(
        'human_gate_conflict',
        'Human Gate supersession identity or revision conflict'
      )
    }
  } else if (request.revision !== 1) {
    throw new OrchestrationError('human_gate_conflict', 'Initial Human Gate revision must be 1')
  }
  const fingerprint = humanGateFingerprint('request', { gate_id: gateId, request })
  db.db
    .prepare(`INSERT INTO human_gate_requests
    (gate_id, run_id, task_id, identity_json, request_json, request_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      gateId,
      run.id,
      taskId,
      canonicalJson(request.identity),
      canonicalJson(request),
      fingerprint
    )
  if (previous) {
    const retirement: HumanGateRetirement = {
      gate_id: previous.gate_id,
      request_fingerprint: previous.request_fingerprint,
      state: 'superseded',
      recorded_at: new Date().toISOString(),
      reason: request.reason,
      successor: { gate_id: gateId, request_fingerprint: fingerprint }
    }
    db.db
      .prepare(`INSERT INTO human_gate_retirements (gate_id, request_fingerprint, retirement_json)
      VALUES (?, ?, ?)`)
      .run(previous.gate_id, previous.request_fingerprint, canonicalJson(retirement))
  }
}
