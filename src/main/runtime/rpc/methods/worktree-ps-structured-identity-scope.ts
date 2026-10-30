import type { RpcContext } from '../core'
import {
  canReadStructuredSessionRecord,
  structuredSessionAdmissionRecord
} from './structured-agent-session-launch-authority'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeWorktreePsResult } from '../../../../shared/runtime-worktree-contracts'

/** Core attach uses trusted CLI inventory; remote handles follow persisted session admission. */
export function scopeWorktreePsStructuredIdentity<T extends RuntimeWorktreePsResult>(
  result: T,
  context?: Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>
): T {
  if (context?.caller?.kind === 'local-cli') {
    return result
  }
  const host = getStructuredAgentSessionHost()
  let redacted = false
  const worktrees = result.worktrees.map((worktree) => {
    if (!worktree.agents.some((agent) => agent.sessionId !== undefined)) {
      return worktree
    }
    const agents = worktree.agents.map((agent) => {
      if (
        agent.sessionId === undefined ||
        (context &&
          canReadStructuredSessionRecord(
            context,
            structuredSessionAdmissionRecord(host, agent.sessionId)
          ))
      ) {
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
