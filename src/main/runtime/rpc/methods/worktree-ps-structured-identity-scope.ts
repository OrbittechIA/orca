import type { RuntimeWorktreePsResult } from '../../../../shared/runtime-worktree-contracts'

/** Caller ownership is not recorded yet; execution ownership cannot grant conversation access. */
export function scopeWorktreePsStructuredIdentity<T extends RuntimeWorktreePsResult>(result: T): T {
  let redacted = false
  const worktrees = result.worktrees.map((worktree) => {
    if (!worktree.agents.some((agent) => agent.sessionId !== undefined)) {
      return worktree
    }
    const agents = worktree.agents.map((agent) => {
      if (agent.sessionId === undefined) {
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
