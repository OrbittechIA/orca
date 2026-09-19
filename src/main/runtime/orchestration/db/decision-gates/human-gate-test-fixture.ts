import type { HumanGateRequest } from '../../../../../shared/human-gate-contract'
import type { OrchestrationDb } from '../orchestration-db'
import { requireHumanGateRecord } from './human-gate-record'

export function humanGateFixture(db: OrchestrationDb): HumanGateRequest {
  const run = db.createRun({
    objective: 'Core #81',
    coordinatorHandle: 'term_owner',
    coordinatorPaneKey: 'folder:ssh:owner'
  })
  const task = db.createTask({ runId: run.id, spec: 'Human Gate persistence' })
  return {
    schema_version: 1,
    revision: 1,
    identity: {
      run_id: run.id,
      task_id: task.id,
      canonical_product: 'oroboros-core',
      mission_id: 'native-gates',
      registration_id: 'registration-81',
      contract_id: 'contract-81-v1'
    },
    requested_at: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    requester: { kind: 'service', id: 'mission-protocol', dispatch_id: null },
    source: { system: 'oroboros-core', version: 'source-commit-81' },
    reason: 'Review exact proposed migration',
    risk: 'schema change',
    scope: 'disposable native database',
    subject: {
      kind: 'pull_request',
      provider: 'gitlab',
      repository: 'example/orca',
      number: 81,
      head_sha: 'a'.repeat(40)
    },
    allows: ['approve this request as decision evidence'],
    does_not_allow: ['merge', 'migrate live database', 'execute an operation'],
    evidence: [
      {
        ref: 'artifact:test-results',
        description: 'isolated validation',
        digest: 'sha256:evidence'
      }
    ],
    supersedes: null
  }
}

export function openHumanGate(db: OrchestrationDb, request: HumanGateRequest) {
  const gate = db.createGate({
    taskId: request.identity.task_id,
    question: request.reason,
    humanGate: request
  })
  return requireHumanGateRecord(db.db, gate.id)
}

export const ownerAuthority = () => ({
  authority: 'test-authenticated-owner',
  subject_id: 'owner-81'
})
