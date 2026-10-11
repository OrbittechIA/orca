import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export type StructuredAgentLaunchPersistedLifecycle = 'pending' | 'visibility-unknown' | 'failed'

export type WorkItemStartPromptIdentity = {
  clientMessageId: string
  bodyFingerprint: string
}

export type StructuredAgentLaunchPersistedRecord = {
  sessionId: string
  /** The host the chat was created on. Records written before paired hosts could hold a chat lack
   *  it and load as local, the only host a chat could then be launched on. */
  executionHostId: ExecutionHostId
  agent: TuiAgent
  lifecycle: StructuredAgentLaunchPersistedLifecycle
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  launchOrigin?: 'work-item-start'
  promptIdentity?: WorkItemStartPromptIdentity
  /** A paired server's reported seed, which this machine cannot re-derive after a reload. */
  seedOptions?: Readonly<Record<string, string>>
  /** When a failed launch failed; records written by older builds lack it. */
  failedAt?: number
}

/** What survives a reload of an unpublished launch. */
export function structuredAgentLaunchRecordFor(
  intent: StructuredAgentSessionLaunchIntent,
  lifecycle: StructuredAgentLaunchPersistedLifecycle
): StructuredAgentLaunchPersistedRecord {
  const { envelope, resumeFrom, launchOrigin } = intent.params
  // A local launch re-reads this machine's settings on reload; only a paired server's seed is kept.
  const pairedSeed = intent.target.kind === 'local' ? undefined : intent.seedOptions
  return {
    sessionId: intent.sessionId,
    executionHostId: intent.executionHostId,
    agent: intent.agent,
    lifecycle,
    clientOperationId: envelope.clientOperationId,
    payloadFingerprint: envelope.payloadFingerprint,
    expectedRuntimeFence: envelope.expectedRuntimeFence,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(launchOrigin ? { launchOrigin } : {}),
    ...(pairedSeed ? { seedOptions: pairedSeed } : {})
  }
}

export function validRecord(value: unknown): value is Omit<
  StructuredAgentLaunchPersistedRecord,
  'executionHostId' | 'promptIdentity'
> & {
  executionHostId?: string
  promptIdentity?: unknown
} {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (
    !('sessionId' in value) ||
    !('agent' in value) ||
    !('lifecycle' in value) ||
    !('clientOperationId' in value) ||
    !('payloadFingerprint' in value) ||
    !('expectedRuntimeFence' in value)
  ) {
    return false
  }
  const {
    sessionId,
    agent,
    lifecycle,
    clientOperationId,
    payloadFingerprint,
    expectedRuntimeFence
  } = value
  const resumeFrom = 'resumeFrom' in value ? value.resumeFrom : undefined
  const executionHostId = 'executionHostId' in value ? value.executionHostId : undefined
  const failedAt = 'failedAt' in value ? value.failedAt : undefined
  const launchOrigin = 'launchOrigin' in value ? value.launchOrigin : undefined
  return (
    (launchOrigin === undefined || launchOrigin === 'work-item-start') &&
    (executionHostId === undefined ||
      (typeof executionHostId === 'string' && parseExecutionHostId(executionHostId) !== null)) &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    isTuiAgent(agent) &&
    (lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed') &&
    typeof clientOperationId === 'string' &&
    typeof payloadFingerprint === 'string' &&
    (expectedRuntimeFence === null || typeof expectedRuntimeFence === 'number') &&
    (failedAt === undefined || Number.isFinite(failedAt)) &&
    (resumeFrom === undefined ||
      (typeof resumeFrom === 'object' &&
        resumeFrom !== null &&
        'providerSessionId' in resumeFrom &&
        typeof resumeFrom.providerSessionId === 'string'))
  )
}

export function readPromptIdentity(value: unknown): WorkItemStartPromptIdentity {
  if (
    typeof value === 'object' &&
    value !== null &&
    'clientMessageId' in value &&
    typeof value.clientMessageId === 'string' &&
    'bodyFingerprint' in value &&
    typeof value.bodyFingerprint === 'string'
  ) {
    return { clientMessageId: value.clientMessageId, bodyFingerprint: value.bodyFingerprint }
  }
  // Retain the unknown operation rather than allowing a new identity after reload.
  return { clientMessageId: '', bodyFingerprint: '' }
}
