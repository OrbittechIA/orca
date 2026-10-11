import { useAppStore } from '@/store'

// Why: activePendingCreationId can outlive the terminal route when the user
// switches app views; only the terminal route renders the creation panel.
export function isPendingCreationSurfaceVisible(creationId: string): boolean {
  const state = useAppStore.getState()
  return state.activeView === 'terminal' && state.activePendingCreationId === creationId
}

// Why: the created row is listed before completion, so a user may already have opened it.
export function isCreatedWorkspaceInView(creationId: string, worktreeId: string): boolean {
  const state = useAppStore.getState()
  return (
    isPendingCreationSurfaceVisible(creationId) ||
    (state.activeView === 'terminal' &&
      state.activePendingCreationId === null &&
      state.activeWorktreeId === worktreeId)
  )
}
