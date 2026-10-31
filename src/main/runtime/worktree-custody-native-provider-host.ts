import type { OrcaRuntimeService } from './orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { pendingWorktreeRemovals, failedWorktreeRemovals } from '../worktree-removal-table'
import { watcherLifecycleState } from '../ipc/filesystem/watchers/filesystem-watcher-lifecycle-state'
import { countRuntimeFileWatcherLeasesOverlapping } from './files/watch/file-watcher-leases'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import { proveWorktreePreservation } from './worktree-custody-preservation'
import { custodyFenceOwnerWitness, nativeWorktreeCustody } from './worktree-custody-runtime'
import { orcadLockHolderHasExited } from '../orcad/orcad-held-instance-lock'
import {
  installNativeWorktreeCustodyRetirement,
  observeWithNativeProducer
} from './worktree-custody-retirement'
import {
  createNativeWorktreeCustodyProvider,
  type NativeCustodyProviderPorts
} from './worktree-custody-native-provider'

/** Binds the provider to this host's real owning registries. */
export function nativeCustodyProviderPorts(
  runtime: OrcaRuntimeService
): NativeCustodyProviderPorts {
  return {
    runtime,
    structuredWork: (sessionId) => getStructuredAgentSessionHost()?.currentWork(sessionId),
    removals: () => [...pendingWorktreeRemovals.values(), ...failedWorktreeRemovals.values()],
    desktopWatchRoots: () => [
      ...[...watcherLifecycleState.watchedRoots.values()].map((root) => root.rootPath),
      ...[...watcherLifecycleState.suspendedLocalWatcherListeners.values()].map(
        (entry) => entry.worktreePath
      ),
      ...watcherLifecycleState.inFlightLocalInstalls.keys(),
      ...watcherLifecycleState.pendingLocalInstallPromises.keys()
    ],
    runtimeWatchLeases: (path) => countRuntimeFileWatcherLeasesOverlapping(path),
    fenceInstalls: (path) => acquireWatcherRemovalGate(path),
    preservation: (path) => proveWorktreePreservation(path),
    // External access still requires a separately qualified native OS authority.
    external: null,
    pairedSelection: runtime.custodySelections ?? null,
    profileLock: { current: custodyFenceOwnerWitness, exited: orcadLockHolderHasExited }
  }
}

const installed = new WeakSet<object>()

/** Startup/host composition only: installs observation, and coverage only when the provider is ready. */
export function installNativeWorktreeCustodyProvider(runtime: OrcaRuntimeService): void {
  const custody = nativeWorktreeCustody(runtime.getRuntimeId())
  if (!custody || installed.has(custody)) {
    return
  }
  installed.add(custody)
  const provider = createNativeWorktreeCustodyProvider(nativeCustodyProviderPorts(runtime))
  custody.installObserver(provider.owner, observeWithNativeProducer(runtime, provider))
  if (provider.ready) {
    installNativeWorktreeCustodyRetirement(runtime, provider)
  }
}
