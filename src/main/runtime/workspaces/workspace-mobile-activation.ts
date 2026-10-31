import { phoneWakeReport } from '../../../shared/workspace-sleep'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export async function activateMobileWorkspace(ports: {
  worktreeId: string
  mobile: boolean
  hydrate: (worktreeId: string, options: { allowAttachedWindow: true }) => void
  refresh: () => Promise<unknown>
  notify: () => void
  wake: () => Promise<unknown>
  readSession: () => WorkspaceSessionState | undefined
  hasWindow: () => boolean
}): Promise<ReturnType<typeof phoneWakeReport> | 'not-applicable'> {
  ports.hydrate(ports.worktreeId, { allowAttachedWindow: true })
  await ports.refresh()
  ports.notify()
  if (!ports.mobile) {
    return 'not-applicable'
  }
  // A running sleep can outlast the phone request, so its wake stays queued.
  void ports.wake()
  return phoneWakeReport(
    ports.readSession()?.sleepingAgentSessionsByPaneKey,
    ports.worktreeId,
    ports.hasWindow()
  )
}
