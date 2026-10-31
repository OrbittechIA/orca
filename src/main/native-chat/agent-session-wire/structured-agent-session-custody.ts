import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { refuseUnclassified } from '../../../shared/agent-session-wire-refusals'
import {
  admitWorktreeCustody,
  WorktreeCustodyAdmissionError
} from '../../runtime/worktree-custody-runtime'

export async function withStructuredAgentSessionCustody<T>(
  location: AgentSessionExecutionLocation | undefined,
  operation: 'attach' | 'operation',
  run: () => Promise<AgentSessionMutationResult<T>>
): Promise<AgentSessionMutationResult<T>> {
  let release: () => void
  try {
    release = location
      ? admitWorktreeCustody(
          location.workspaceId,
          undefined,
          location.wslDistro ? 'wsl' : location.executionHostId
        )
      : () => {}
  } catch (error) {
    if (!(error instanceof WorktreeCustodyAdmissionError)) {
      throw error
    }
    return {
      ok: false,
      refusal: {
        ...refuseUnclassified(
          'agent_session_ownership_unknown',
          `Workspace custody prevents this ${operation} before any session mutation.`
        ),
        ...(operation === 'attach' ? { createAttemptRefusedBeforeCommit: true } : {})
      }
    }
  }
  try {
    return await run()
  } finally {
    release()
  }
}
