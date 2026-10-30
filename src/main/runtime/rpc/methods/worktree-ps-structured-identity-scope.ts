import type { RpcContext } from '../core'
import { canAccessWorkItemStartStructuredSession } from './structured-agent-session-launch-authority'
import type { RuntimeWorktreePsResult } from '../../../../shared/runtime-worktree-contracts'

/** Publish identity only with exact persisted launch ownership. */
export function scopeWorktreePsStructuredIdentity<T extends RuntimeWorktreePsResult>(result: T, context?: Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>): T {
  let redacted = false
  const worktrees = result.worktrees.map((worktree) => {
    if (!worktree.agents.some((agent) => agent.sessionId !== undefined)) {
      return worktree
    }
    const agents = worktree.agents.map((agent) => {
      if (agent.sessionId === undefined || (context && canAccessWorkItemStartStructuredSession(context, agent.sessionId))) {
        return agent
      }
      redacted = true
      const { sessionId: _sessionId, ...visible } = agent
      return visible
    })
    return { ...worktree, agents }
  })
  return redacted ? { ...result, worktrees } : result
}
