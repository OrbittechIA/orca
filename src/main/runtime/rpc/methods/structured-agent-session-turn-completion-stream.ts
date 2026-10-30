// Emit future turn completions and opted-in prompts only; unlike status snapshots, missed edges never replay.

import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import {
  requireStructuredSessionHost,
  canReachStructuredSession,
  requireStructuredAgentAudience,
  requireStructuredCapability,
  requireStructuredHost as requireHost
} from './structured-agent-session-gate'
import { canReadStructuredSessionRecord } from './structured-agent-session-launch-authority'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  AcknowledgeAttentionParams,
  SubscribeTurnCompletionsParams
} from './structured-agent-session-schemas'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

/** Prove the caller may act on the session from its durable record, opening the shared store rather than a provider host. */
async function requireAttentionSessionAdmission(ctx: RpcContext, sessionId: string): Promise<void> {
  requireStructuredCapability(ctx)
  if (getStructuredAgentSessionHost()) {
    requireStructuredSessionHost(ctx, sessionId)
    return
  }
  const record = (await ctx.runtime.openAgentSessionRecordStore()).getRecord(sessionId)
  if (!record || !canReadStructuredSessionRecord(ctx, record)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  requireStructuredAgentAudience(ctx, record.provider)
}

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  // Retire only prompt deliveries covered by the accepted read's session/epoch, without installing the host.
  defineMethod({
    name: 'agentSession.acknowledgeAttention',
    permission: 'workspace',
    params: AcknowledgeAttentionParams,
    handler: async (params, ctx) => {
      await requireAttentionSessionAdmission(ctx, params.sessionId)
      ctx.runtime.retireStructuredAttention({
        sessionId: params.sessionId,
        observedCursor: params.observedCursor
      })
      return { acknowledged: true }
    }
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletions',
    permission: 'workspace',
    params: SubscribeTurnCompletionsParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionTurnCompletionSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = host.subscribeTurnCompletions({
        id: subscriptionId,
        // A client that cannot read an agent's rows is not told that agent's edges either.
        emit: (event) => {
          const sessionId =
            event.type === 'completion'
              ? event.completion.sessionId
              : event.type === 'prompt'
                ? event.prompt.sessionId
                : undefined
          if (
            sessionId === undefined ||
            (canReachStructuredSession(ctx, host, sessionId) &&
              clientReadsStructuredSessionAgent(ctx, host.sessionAgent(sessionId) ?? ''))
          ) {
            emit(event)
          }
        },
        includePrompts: params.includePrompts === true
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
