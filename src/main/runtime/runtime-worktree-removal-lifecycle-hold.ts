import type { ExecutionHostId } from '../../shared/execution-host'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { resolveWorktreeRemovalRepoOwner } from '../worktree-removal-repo-owner'

/** A removal waits this long for in-flight structured creates before refusing as busy. */
export const WORKTREE_REMOVAL_LIFECYCLE_WAIT_MS = 30_000

/**
 * What a removal needs to name its lifecycle scope: the record it removes and the host it will
 * run on. Without an explicit host the owner repo's host is used, the same host the removal
 * itself routes to; an ambiguous owner leaves the scope local and is refused by the removal.
 */
export type WorktreeRemovalLifecycleScope = {
  store: Parameters<typeof resolveWorktreeRemovalRepoOwner>[0]
  removalTarget: { id: string; repoId: string }
  hostId?: ExecutionHostId
}

/**
 * Runs a workspace removal on the exclusive side of the workspace lifecycle: a structured
 * session create that already resolved this record holds the shared side until its provider
 * child is attached, so the record cannot be deleted or replaced underneath the authority it
 * was admitted with. Past the wait the removal is refused (`worktree_lifecycle_busy`), never
 * granted later.
 */
export async function removeWithWorktreeLifecycleHeld<T>(
  runtime: {
    holdWorktreeLifecycleExclusively: (
      worktreeId: string,
      deadline?: number,
      executionHostId?: string | null
    ) => Promise<() => void>
  },
  scope: WorktreeRemovalLifecycleScope,
  removal: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const owner = resolveWorktreeRemovalRepoOwner(
    scope.store,
    scope.removalTarget.repoId,
    scope.hostId
  )
  const hostId =
    scope.hostId ?? (owner.kind === 'resolved' ? getRepoExecutionHostId(owner.repo) : undefined)
  const release = await runtime.holdWorktreeLifecycleExclusively(
    scope.removalTarget.id,
    now() + WORKTREE_REMOVAL_LIFECYCLE_WAIT_MS,
    hostId
  )
  try {
    return await removal()
  } finally {
    release()
  }
}
