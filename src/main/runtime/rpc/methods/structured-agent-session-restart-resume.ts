// `agentSession.restartResumable` / `agentSession.restartResume` — the restart-resume offer.
//
// Both reach for records on disk this process may not have opened yet, so they build the host the
// way hold and reveal do. Listing is read-only and takes nothing live; resuming goes through the
// host's single resume path, which re-derives eligibility rather than trusting the ids it is given.
//
// Every id is authorized per session: a Work Item Start session is listed and resumed by its owner
// alone, even with the global setting off, and never by another paired device.

import { defineMethod, type RpcContext } from '../core'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  canReachStructuredSession,
  ensureStructuredHostInstalled,
  requireStructuredHost,
  requireWorkItemStartStatusHost,
  structuredCallerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import { RestartResumableParams, RestartResumeParams } from './structured-agent-session-schemas'

async function requireRestartResumeHost(
  ctx: RpcContext,
  sessionIds?: readonly string[]
): Promise<StructuredAgentSessionHost> {
  if (supportsStructuredSessions(ctx)) {
    await ensureStructuredHostInstalled(ctx)
    return requireStructuredHost(ctx)
  }
  await ensureStructuredHostInstalled(
    ctx,
    sessionIds?.[0] ? { sessionId: sessionIds[0] } : { workItemStartOnly: true }
  )
  // Refuses exactly as v1.4.209 did unless this caller owns at least one Start session.
  return requireWorkItemStartStatusHost(ctx)
}

/** Named ids must all be reachable; an omitted list narrows to the reachable candidates, and stays
 *  omitted only when that drops nothing, so the global path keeps its exact call. */
async function authorizedResumeSessionIds(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  requested: readonly string[] | undefined
): Promise<readonly string[] | undefined> {
  if (requested) {
    if (requested.length === 0) {
      requireStructuredHost(ctx)
    }
    for (const sessionId of requested) {
      requireStructuredHost(ctx, sessionId)
    }
    return requested
  }
  const candidates = await host.restartResume.list()
  const reachable = candidates.filter((candidate) =>
    canReachStructuredSession(ctx, host, candidate.sessionId)
  )
  return reachable.length === candidates.length && supportsStructuredSessions(ctx)
    ? undefined
    : reachable.map((candidate) => candidate.sessionId)
}

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      const host = await requireRestartResumeHost(ctx)
      const sessions = await host.restartResume.list()
      return {
        sessions: sessions.filter((session) =>
          canReachStructuredSession(ctx, host, session.sessionId)
        )
      }
    }
  }),
  defineMethod({
    // Spends the markers without resuming; see the collaborator for why turning the offer down
    // consumes it rather than leaving it to return at every launch.
    name: 'agentSession.restartResumableDismiss',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      return { dismissed: await requireStructuredHost(ctx).restartResume.dismiss() }
    }
  }),
  defineMethod({
    // Reconnect AND ask each reconnected agent to carry on. Separate from `restartResume` on
    // purpose: that method sends nothing, and the automatic-reconnect setting only ever calls it,
    // so no configuration can reach this one.
    name: 'agentSession.restartContinue',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      const host = await requireRestartResumeHost(ctx, params.sessionIds)
      return host.restartResume.continueAfterRestart(
        await authorizedResumeSessionIds(ctx, host, params.sessionIds),
        structuredCallerFor(ctx).callerKey
      )
    }
  }),
  defineMethod({
    name: 'agentSession.restartResume',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      const host = await requireRestartResumeHost(ctx, params.sessionIds)
      return {
        results: await host.restartResume.resume(
          await authorizedResumeSessionIds(ctx, host, params.sessionIds),
          structuredCallerFor(ctx).callerKey
        )
      }
    }
  })
]
