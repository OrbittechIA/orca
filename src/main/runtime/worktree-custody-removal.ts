import { admitWorktreeCustody } from './worktree-custody-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { resolveWorktreeRemovalRepoOwner } from '../worktree-removal-repo-owner'
import { waitForPendingWorktreeRemoval } from '../worktree-background-removal'
import {
  assertWslMoveWorkspaceWritable,
  isWslMoveSourceHost
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

export async function withManagedWorktreeRemovalCustody<T>(
  store: RuntimeStore,
  target: RuntimeWorktreeRemovalTarget,
  cleanupHostId: ExecutionHostId | undefined,
  remove: () => Promise<T>
): Promise<T> {
  const owner = resolveWorktreeRemovalRepoOwner(store, target.repoId, cleanupHostId)
  const hostId = owner.kind === 'resolved' ? getRepoExecutionHostId(owner.repo) : cleanupHostId
  const release = admitWorktreeCustody(target.id, target.path, hostId, false)
  try {
    if (isWslMoveSourceHost(hostId)) {
      assertWslMoveWorkspaceWritable(store, target.id)
    }
    return await remove()
  } finally {
    const pending = waitForPendingWorktreeRemoval(target.id, hostId)
    if (pending) {
      void pending.then(release, release)
    } else {
      release()
    }
  }
}
