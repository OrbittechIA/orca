import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import type { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import { requestStructuredAgentSessionMutation } from '../session/mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import {
  clearMobileStructuredSendOperation,
  getOrCreateMobileStructuredSendOperation,
  mobileStructuredSendOperationKey
} from '../session/mobile-structured-send-operation-journal'
import type { RpcClient } from '../transport/rpc-client'
import type { WorkItemStartStructuredSessionResult } from './work-item-start-structured-session'

/** Same-envelope replays after an unknown outcome, before the Start reports unconfirmed. */
const SEND_UNKNOWN_REPLAY_DELAYS_MS: readonly number[] = [250, 1_000]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Delivers the single Work Item Start prompt under one durable operation id.
 *
 * The envelope is persisted BEFORE the first dispatch: the host may commit the send and lose
 * only the reply, and a client that then mints a second id would put the prompt in provider
 * context twice. An unknown outcome (lost reply, `agent_session_operation_unknown`) replays the
 * exact same envelope — idempotent on the host — a bounded number of times, and what is still
 * unknown after that stays persisted for a later reconcile. Only a settled outcome clears it.
 */
export async function deliverWorkItemStartPrompt(args: {
  client: RpcClient
  worktreeId: string
  sessionId: string
  fence: number
  body: ReturnType<typeof structuredAgentSessionSendBody>
}): Promise<WorkItemStartStructuredSessionResult> {
  const { client, worktreeId, sessionId, fence, body } = args
  const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body }
  })
  const operationKey = mobileStructuredSendOperationKey({
    sessionKey: sessionId,
    intentFingerprint: payloadFingerprint
  })
  let persisted: Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>
  try {
    persisted = await getOrCreateMobileStructuredSendOperation({
      operationKey,
      callerIdentity: `work-item-start:${worktreeId}`,
      payloadFingerprint,
      attachmentPaths: [],
      createOperationId: structuredSessionOperationId
    })
  } catch (error) {
    // No durable record means no safe way to replay: the prompt is reported, not sent.
    return {
      kind: 'prompt-undelivered',
      sessionId,
      message: `The Work Item Start prompt was not sent: ${error instanceof Error ? error.message : 'its send operation could not be recorded'}.`
    }
  }
  const clientOperationId = persisted.operationId
  const pendingSend = { clientOperationId, fence }
  const settle = async (
    result: WorkItemStartStructuredSessionResult
  ): Promise<WorkItemStartStructuredSessionResult> => {
    await clearMobileStructuredSendOperation({
      operationKey,
      operationId: clientOperationId
    }).catch(() => undefined)
    return result
  }
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
    // `settled-rejected` clears it.
    if (
      delivery.status === 'unknown' ||
      (delivery.status === 'refused' &&
        agentSessionRefusalOperationState('agentSession.send', delivery.code) !==
          'settled-rejected')
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
    return settleWorkItemStartDelivery(delivery, sessionId, pendingSend, settle)
  }
}

async function settleWorkItemStartDelivery(
  delivery: Exclude<
    Awaited<ReturnType<typeof requestStructuredAgentSessionMutation<AgentSessionSendResult>>>,
    { status: 'unknown' }
  >,
  sessionId: string,
  pendingSend: { clientOperationId: string; fence: number },
  settle: (
    result: WorkItemStartStructuredSessionResult
  ) => Promise<WorkItemStartStructuredSessionResult>
): Promise<WorkItemStartStructuredSessionResult> {
  const launch = { sessionId }
  if (delivery.status === 'accepted') {
    // `ok` is the mutation verdict, not the dispatch verdict: the host accepts the envelope and
    // then reports separately whether the provider actually took the turn.
    const dispatch = delivery.value?.submission?.dispatchState
    if (dispatch === 'accepted') {
      return settle({ kind: 'started', sessionId: launch.sessionId })
    }
    if (dispatch === 'rejected') {
      return settle({
        kind: 'prompt-undelivered',
        sessionId: launch.sessionId,
        message:
          delivery.value?.submission?.reason ??
          'The agent session rejected the Work Item Start prompt.'
      })
    }
    // `pending`/`unknown` dispatch: the host holds the envelope; the record stays until the
    // journal settles it.
    return {
      kind: 'unconfirmed',
      sessionId: launch.sessionId,
      pendingSend,
      message:
        'The Work Item Start prompt was submitted but not confirmed. Open the session before sending it again.'
    }
  }
  return settle({
    kind: 'prompt-undelivered',
    sessionId: launch.sessionId,
    message: delivery.message
  })
}
