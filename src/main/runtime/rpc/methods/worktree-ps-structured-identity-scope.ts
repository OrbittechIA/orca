// Scopes the structured session identity `worktree.ps` publishes to the caller that may reach it.
//
// The host lists every structured session's row, including another device's Work Item Start
// session. The row itself (status, prompt) stays visible like any agent row; the session id and
// provider thread id are the handles that reach the conversation, so they go only to a caller the
// structured gate would admit to that session.
import type { RuntimeWorktreePsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { canReachStructuredSession } from './structured-agent-session-gate'

export function scopeWorktreePsStructuredIdentity(
  result: RuntimeWorktreePsResult,
  ctx: RpcContext
): RuntimeWorktreePsResult {
  const host = getStructuredAgentSessionHost()
  // In-process callers are the host's own build and read everything.
  if (!host || ctx.clientKind === undefined) {
    return result
  }
  let redacted = false
  const worktrees = result.worktrees.map((worktree) => {
    if (!worktree.agents.some((agent) => agent.sessionId !== undefined)) {
      return worktree
    }
    const agents = worktree.agents.map((agent) => {
      if (agent.sessionId === undefined || canReachStructuredSession(ctx, host, agent.sessionId)) {
        return agent
      }
      redacted = true
      const { sessionId: _sessionId, providerSession: _providerSession, ...visible } = agent
      return visible
    })
    return { ...worktree, agents }
  })
  return redacted ? { ...result, worktrees } : result
}
