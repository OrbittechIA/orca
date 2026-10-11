import {
  agentSessionSendSubmission,
  type AgentSessionSendResult
} from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionRejectionNotice } from '../../../src/shared/structured-agent-session-rejection-words'
import { parseAgentSessionOperationTimestamp } from '../../../src/shared/agent-session-host-authority'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import { structuredAgentSessionDomainFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import {
  agentSessionSendBodyFingerprint,
  type structuredAgentSessionSendBody
} from '../../../src/shared/structured-agent-session-send-mutation'
import { requestStructuredAgentSessionMutation } from '../session/mobile-structured-agent-session-rpc'
import { readLegacyWorkItemStartSendIdentity } from './work-item-start-legacy-send-identity'
import type { RpcClient } from '../transport/rpc-client'
import { recordWorkItemStartSendIdentity } from './work-item-start-send-identity-journal'
import type { WorkItemStartStructuredSessionResult } from './work-item-start-structured-session'

/** Same-envelope replays after an unknown outcome, before the Start reports unconfirmed. */
const SEND_UNKNOWN_REPLAY_DELAYS_MS: readonly number[] = [250, 1_000]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Delivers the single Work Item Start prompt under one durable operation id.
 *
 * The Start sidecar binds the original send id to its caller, session and prompt before dispatch.
 * Unknown outcomes replay that envelope a bounded number of times, retaining it for reconciliation.
 */
export async function deliverWorkItemStartPrompt(args: {
  client: RpcClient
  worktreeId: string
  sessionId: string
  attemptSessionId: string
  attemptCreateClientOperationId: string
  sendClientOperationId?: string
  fence: number
  body: ReturnType<typeof structuredAgentSessionSendBody>
}): Promise<WorkItemStartStructuredSessionResult> {
  const { client, worktreeId, sessionId, fence, body } = args
  const binding = {
    sessionId,
    payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, body),
    callerFingerprint: structuredAgentSessionDomainFingerprint({
      domain: 'mobile.agentSession.send.caller',
      sessionId: `work-item-start:${worktreeId}`,
      fields: {}
    })
  }
  let clientOperationId = args.sendClientOperationId
  try {
    const legacyId = await readLegacyWorkItemStartSendIdentity(binding)
    if (clientOperationId && legacyId && clientOperationId !== legacyId) {
      return {
        kind: 'unconfirmed',
        sessionId,
        message:
          'The earlier Work Item Start send identity conflicts. Check the conversation before sending the prompt again.'
      }
    }
    clientOperationId ??= legacyId
  } catch {
    return {
      kind: 'unconfirmed',
      sessionId,
      message:
        'The earlier Work Item Start send identity could not be confirmed. Check the conversation before sending the prompt again.'
    }
  }
  if (!clientOperationId || parseAgentSessionOperationTimestamp(clientOperationId) === null) {
    return {
      kind: 'unconfirmed',
      sessionId,
      message:
        'The earlier Work Item Start could not be confirmed. Check the conversation before sending the prompt again.'
    }
  }
  try {
    clientOperationId = await recordWorkItemStartSendIdentity(
      {
        worktreeId,
        sessionId: args.attemptSessionId,
        createClientOperationId: args.attemptCreateClientOperationId
      },
      clientOperationId,
      binding
    )
  } catch {
    return {
      kind: 'unconfirmed',
      sessionId,
      message: 'The Work Item Start send identity could not be saved. Retry Start to reconcile it.'
    }
  }
  const pendingSend = { clientOperationId, fence }
  for (let attempt = 0; ; attempt += 1) {
    const delivery = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
      client,
      method: 'agentSession.send',
      fingerprintMethod: 'agentSession.send',
      sessionId,
      expectedRuntimeFence: fence,
      fields: { body },
      clientOperationId
    })
    // A refusal is settled only when the ledger says so. `pending-admission` (capacity, a host
    // still reconciling) and `unknown` prove nothing about M1, which the host may already hold:
    // the same envelope is replayed, and if still undecided it stays persisted. Only
    // `settled-rejected` releases the Start identity.
    if (
      delivery.status === 'unknown' ||
      (delivery.status === 'refused' &&
        agentSessionRefusalOperationState(delivery.code) !== 'settled-rejected')
    ) {
      const replayDelayMs = SEND_UNKNOWN_REPLAY_DELAYS_MS[attempt]
      if (replayDelayMs === undefined) {
        return {
          kind: 'unconfirmed',
          sessionId,
          pendingSend,
          message:
            'The Work Item Start prompt could not be confirmed. Open the session before sending it again.'
        }
      }
      await delay(replayDelayMs)
      continue
    }
    return settleWorkItemStartDelivery(delivery, sessionId, pendingSend)
  }
}

function settleWorkItemStartDelivery(
  delivery: Exclude<
    Awaited<ReturnType<typeof requestStructuredAgentSessionMutation<AgentSessionSendResult>>>,
    { status: 'unknown' }
  >,
  sessionId: string,
  pendingSend: { clientOperationId: string; fence: number }
): WorkItemStartStructuredSessionResult {
  const launch = { sessionId }
  if (delivery.status === 'accepted') {
    // `ok` is the mutation verdict, not the dispatch verdict: the host accepts the envelope and
    // then reports separately whether the provider actually took the turn.
    const submission = agentSessionSendSubmission(delivery.value)
    const dispatch = submission?.dispatchState
    if (dispatch === 'accepted') {
      return { kind: 'started', sessionId: launch.sessionId }
    }
    if (dispatch === 'rejected') {
      return {
        kind: 'prompt-undelivered',
        sessionId: launch.sessionId,
        message: structuredAgentSessionRejectionNotice(submission?.reason ?? null, 'send')
      }
    }
    // Pending dispatch keeps the Start identity for its next reconciliation.
    return {
      kind: 'unconfirmed',
      sessionId: launch.sessionId,
      pendingSend,
      message:
        'The Work Item Start prompt was submitted but not confirmed. Open the session before sending it again.'
    }
  }
  return {
    kind: 'prompt-undelivered',
    sessionId: launch.sessionId,
    message: delivery.message
  }
}
