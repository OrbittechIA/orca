import type { WorktreeCustodyResource, WorktreeCustodyFence } from '../../shared/worktree/custody'
import type { NativeCustodyProviderPorts } from './worktree-custody-native-provider'

const INSTALL_DRAIN_MS = 5_000

async function withinDeadline(ready: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function acquireNativeCustodyGrant(
  ports: NativeCustodyProviderPorts,
  resource: WorktreeCustodyResource,
  fence: WorktreeCustodyFence | undefined,
  registeredConsumers: (path: string) => number
): Promise<{ check(): boolean; release(): void }> {
  const selectionAuthority = ports.pairedSelection
  const selectionGeneration = selectionAuthority?.generation
  // Admission already refuses Orca entrypoints for the fenced path; this also closes watcher/PTY installs.
  const installs = ports.fenceInstalls(resource.path)
  let external: { check: () => boolean; release: () => void } | null = null
  let paired: { check: () => boolean; release: () => void } | null = null
  try {
    if (!(await withinDeadline(installs.ready, INSTALL_DRAIN_MS))) {
      throw new Error('custody_consumer_install_pending')
    }
    if (registeredConsumers(resource.path) > 0) {
      throw new Error('custody_registered_consumer_held')
    }
    if (!ports.external) {
      throw new Error('custody_external_consumer_unproven')
    }
    if (
      selectionAuthority?.complete !== true ||
      !Number.isSafeInteger(selectionGeneration) ||
      selectionAuthority.selects(resource.worktreeId, resource.path, resource.hostId)
    ) {
      throw new Error('custody_selection_held')
    }
    if (!fence || !selectionAuthority.acquire) {
      throw new Error('custody_selection_fence_unbound')
    }
    paired = await selectionAuthority.acquire(fence)
    external = await ports.external.acquire(resource, fence)
  } catch (error) {
    external?.release()
    installs.release()
    throw error
  }
  const grant = external
  const selection = paired
  let released = false
  let cleanupDone = false
  return {
    // Synchronous and side-effect-free: only registry reads.
    check: () =>
      !released &&
      !cleanupDone &&
      ports.pairedSelection === selectionAuthority &&
      selectionAuthority?.generation === selectionGeneration &&
      selection?.check() === true &&
      registeredConsumers(resource.path) === 0 &&
      grant.check(),
    release: () => {
      if (released) {
        return
      }
      try {
        selection?.release()
        released = true
      } finally {
        if (!cleanupDone) {
          cleanupDone = true
          try {
            grant.release()
          } finally {
            installs.release()
          }
        }
      }
    }
  }
}
