import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AgentLaunchRequestId } from './agent-launch-request-id'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'
import { getJoinableStructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-holders'

const pendingSourceJoiners = new WeakMap<StructuredAgentSessionLaunchIntent, Set<Promise<void>>>()

// Joiners without the source terminal survive its close: hand off unsent create to conversation-ID resume, as History does.
export function releaseStructuredLaunchSource(state: StructuredLaunchState): void {
  const { intent } = state
  const handoff = intent.beforeCreate
  if (!handoff) {
    return
  }
  delete intent.beforeCreate
  handoff()
  const resumeFrom = intent.params.resumeFrom
  if (!resumeFrom?.cliSource) {
    return
  }
  const { cliSource: _paneSource, ...resumeById } = resumeFrom
  const params = { ...intent.params, resumeFrom: resumeById }
  intent.params = {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: intent.sessionId,
        ...params
      })
    }
  }
  setStructuredLaunchState(state)
}

/** Holds a source-bound create for an independent joiner still awaiting host admission. */
export function holdStructuredLaunchSourceForJoiner(args: {
  worktreeId: string
  agent: TuiAgent
  executionHostId: ExecutionHostId
  resumeFrom?: StructuredAgentSessionResumeSource
  requestId: AgentLaunchRequestId
}): () => void {
  const { resumeFrom } = args
  if (!resumeFrom || resumeFrom.cliSource) {
    return () => {}
  }
  const identity = structuredLaunchIdentity(args.worktreeId, args.agent, {
    resumeFrom,
    executionHostId: args.executionHostId
  })
  const intent = getJoinableStructuredLaunchState(identity, args.requestId)?.intent
  if (!intent?.beforeCreate) {
    return () => {}
  }
  let settle = (): void => {}
  const held = new Promise<void>((resolve) => {
    settle = resolve
  })
  const holds = pendingSourceJoiners.get(intent) ?? new Set<Promise<void>>()
  holds.add(held)
  pendingSourceJoiners.set(intent, holds)
  return () => {
    holds.delete(held)
    settle()
  }
}

export function hasPendingStructuredLaunchSourceJoiners(
  intent: StructuredAgentSessionLaunchIntent
): boolean {
  return !!intent.beforeCreate && !!pendingSourceJoiners.get(intent)?.size
}

/** Waits until no joiner awaiting host admission can still take over this intent's source-bound create. */
export async function settleStructuredLaunchSourceJoiners(
  intent: StructuredAgentSessionLaunchIntent
): Promise<void> {
  while (hasPendingStructuredLaunchSourceJoiners(intent)) {
    const holds = pendingSourceJoiners.get(intent)
    if (holds) {
      await Promise.all(holds)
    }
  }
}
