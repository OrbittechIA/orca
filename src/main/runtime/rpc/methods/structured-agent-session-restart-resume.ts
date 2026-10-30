// Build durable-record access lazily and scope every restart offer action to agents this client renders.
// Listing spends no offer; resume re-derives eligibility from host state, never trusts supplied ids.

import { defineMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost,
  requireStructuredSessionHost,
  canReachStructuredSession,
  requireStructuredSessionAdmission,
  structuredCallerFor
} from './structured-agent-session-gate'
import {
  ContinueInterruptedParams,
  RestartResumableParams,
  RestartResumeParams
} from './structured-agent-session-schemas'
import { structuredAgentsReadBy } from './structured-agent-session-policy'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionRestartReach } from '../../../native-chat/agent-session-wire/structured-agent-session-restart-resume-set'

/** Unnamed actions keep their all-offers meaning, limited under the capsule lock to sessions this caller may act on. */
function restartReachFor(
  ctx: RpcContext,
  host: StructuredAgentSessionHost
): StructuredAgentSessionRestartReach {
  return (sessionId) => canReachStructuredSession(ctx, host, sessionId)
}

function requireNamedRestartSessions(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionIds: readonly string[] | undefined
): void {
  for (const id of sessionIds ?? []) {
    requireStructuredSessionAdmission(ctx, host, id)
  }
}

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    permission: 'workspace',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      return {
        sessions: (await host.restartResume.list(audience)).filter((row) =>
          canReachStructuredSession(ctx, host, row.sessionId)
        ),
        // Acted-on offers whose agent did not carry on. Optional on the wire; older clients ignore it.
        failed: (await host.restartResume.listFailures(audience)).filter((row) =>
          canReachStructuredSession(ctx, host, row.sessionId)
        )
      }
    }
  }),
  defineMethod({
    // Explicit dismissal abandons markers; dialog close only snoozes so the status-bar offer remains.
    name: 'agentSession.restartResumableDismiss',
    permission: 'workspace',
    params: RestartResumableParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      // Offers this client was never shown stay for a client that can show them.
      const audience = structuredAgentsReadBy(ctx, host.knownAgentIds())
      requireNamedRestartSessions(ctx, host, params.sessionIds)
      const dismissed = await host.restartResume.dismiss(
        params.sessionIds,
        audience,
        restartReachFor(ctx, host)
      )
      if (params.sessionIds === undefined) {
        // Dismissal already removed everything this client sees; another read adds only a post-success failure point.
        return { dismissed, sessions: [], failed: [] }
      }
      return {
        dismissed,
        sessions: (await host.restartResume.list(audience)).filter((row) =>
          canReachStructuredSession(ctx, host, row.sessionId)
        ),
        failed: (await host.restartResume.listFailures(audience)).filter((row) =>
          canReachStructuredSession(ctx, host, row.sessionId)
        )
      }
    }
  }),
  defineMethod({
    // Reattach and ask agents to continue, for prompt/settings resume; legacy restartResume sends nothing.
    name: 'agentSession.restartContinue',
    permission: 'workspace',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      requireNamedRestartSessions(ctx, host, params.sessionIds)
      const result = await host.restartResume.continueAfterRestart(
        params.sessionIds,
        structuredCallerFor(ctx).callerKey,
        structuredAgentsReadBy(ctx, host.knownAgentIds()),
        restartReachFor(ctx, host)
      )
      return {
        ...result,
        ...(result.sessions
          ? {
              sessions: result.sessions.filter((row) =>
                canReachStructuredSession(ctx, host, row.sessionId)
              )
            }
          : {}),
        ...(result.failed
          ? {
              failed: result.failed.filter((row) =>
                canReachStructuredSession(ctx, host, row.sessionId)
              )
            }
          : {})
      }
    }
  }),
  defineMethod({
    // Continue the exact interrupted turn, separate from restart offers; clients negotiate its capability and name a readable chat.
    name: 'agentSession.continueInterrupted',
    permission: 'workspace',
    params: ContinueInterruptedParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredSessionHost(ctx, params.sessionId)
      return host.restartResume.continueInterrupted(params.sessionId, params.turnItemId)
    }
  }),
  defineMethod({
    // Keep published legacy reattach-only RPC answering no resume: agents now start only for work, and removal would break old clients.
    name: 'agentSession.restartResume',
    permission: 'workspace',
    params: RestartResumeParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      requireStructuredHost(ctx)
      return { results: [] }
    }
  })
]
