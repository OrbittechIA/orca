/** A removal waits this long for in-flight structured creates before refusing as busy. */
export const WORKTREE_REMOVAL_LIFECYCLE_WAIT_MS = 30_000

/**
 * Runs a workspace removal on the exclusive side of the workspace lifecycle: a structured
 * session create that already resolved this record holds the shared side until its provider
 * child is attached, so the record cannot be deleted or replaced underneath the authority it
 * was admitted with. Past the wait the removal is refused (`worktree_lifecycle_busy`), never
 * granted later.
 */
export async function removeWithWorktreeLifecycleHeld<T>(
  runtime: {
    holdWorktreeLifecycleExclusively: (worktreeId: string, deadline?: number) => Promise<() => void>
  },
  worktreeId: string,
  removal: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const release = await runtime.holdWorktreeLifecycleExclusively(
    worktreeId,
    now() + WORKTREE_REMOVAL_LIFECYCLE_WAIT_MS
  )
  try {
    return await removal()
  } finally {
    release()
  }
}
