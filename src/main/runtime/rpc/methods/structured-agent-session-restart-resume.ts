// The restart-resume offer: list it, act on it, or turn it down.
//
// Each method reaches for records on disk this process may not have opened yet, so each builds the
// host the way hold and reveal do. Listing takes nothing live and spends no live offer; acting goes
// through the host's single resume path, which re-derives eligibility rather than trusting the ids
// it is given.

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
  requested: readonly string[] | undefined,
  includeFailures = false
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
  const candidates = [
    ...(await host.restartResume.list()),
    ...(includeFailures ? await host.restartResume.listFailures() : [])
  ]
  const reachable = candidates.filter((candidate) =>
    canReachStructuredSession(ctx, host, candidate.sessionId)
  )
  return reachable.length === candidates.length && supportsStructuredSessions(ctx)
    ? undefined
    : [...new Set(reachable.map((candidate) => candidate.sessionId))]
}

export const STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS = [
  defineMethod({
    name: 'agentSession.restartResumable',
    params: RestartResumableParams,
    handler: async (_params, ctx) => {
      const host = await requireRestartResumeHost(ctx)
      return {
        sessions: (await host.restartResume.list()).filter((session) =>
          canReachStructuredSession(ctx, host, session.sessionId)
        ),
        // Acted-on offers whose agent did not carry on. Optional on the wire; older clients ignore it.
        failed: (await host.restartResume.listFailures()).filter((session) =>
          canReachStructuredSession(ctx, host, session.sessionId)
        )
      }
    }
  }),
  defineMethod({
    // Explicitly abandons the markers without resuming. Closing the dialog is a snooze and does
    // not call this method, so the status-bar entry can reopen the offer later.
    name: 'agentSession.restartResumableDismiss',
    params: RestartResumableParams,
    handler: async (params, ctx) => {
      const host = await requireRestartResumeHost(ctx)
      const dismissed = await host.restartResume.dismiss(
        await authorizedResumeSessionIds(ctx, host, params.sessionIds, true)
      )
      if (params.sessionIds === undefined) {
        // clearAll is the authoritative mutation: it removes pending and in-flight records, so a
        // second read would only add a new failure point after the user's explicit dismissal.
        return { dismissed, sessions: [], failed: [] }
      }
      return {
        dismissed,
        sessions: (await host.restartResume.list()).filter((session) =>
          canReachStructuredSession(ctx, host, session.sessionId)
        ),
        failed: (await host.restartResume.listFailures()).filter((session) =>
          canReachStructuredSession(ctx, host, session.sessionId)
        )
      }
    }
  }),
  defineMethod({
    // Reattach AND ask each reattached agent to carry on — what the desktop prompt calls resuming,
    // and what an opted-in launch runs without asking. Separate from `restartResume`, which sends
    // nothing, but reachable from a setting rather than only from a button.
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
    // Reattach only, no send. Reattaching is nothing now — an agent starts only for work — so this
    // answers that nothing was resumed. No Orca surface calls it, but it is a PUBLISHED wire
    // method, so dropping it is a wire removal an older client would meet as an unknown method.
    name: 'agentSession.restartResume',
    params: RestartResumeParams,
    handler: async (params, ctx) => {
      const host = await requireRestartResumeHost(ctx, params.sessionIds)
      await authorizedResumeSessionIds(ctx, host, params.sessionIds)
      return { results: [] }
    }
  })
]
