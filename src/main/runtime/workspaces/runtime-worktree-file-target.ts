import { assertWorktreeCustodyAdmission } from '../worktree-custody-runtime'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { RuntimeStore } from '../runtime-store-contract'
import { resolveWorktreeHostRouting } from '../worktree-launch-host-repo'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function runtimeWorktreeFileTarget(
  worktree: ResolvedWorktree,
  requireStore: () => RuntimeStore
) {
  assertWorktreeCustodyAdmission(worktree.id, worktree.path, worktree.hostId)
  const routing = resolveWorktreeHostRouting(requireStore().getRepos(), worktree)
  if (routing.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return {
    worktree,
    executionHostId: routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
  }
}
