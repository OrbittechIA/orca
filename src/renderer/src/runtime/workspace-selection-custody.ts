import { createUuidV4 } from '../../../shared/uuid-v4'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  SelectionFrameSchema,
  WORKTREE_SELECTION_CAPABILITY
} from '../../../shared/worktree/custody-selection'
import { WorktreeSelectionClient } from '../../../shared/worktree/custody-selection-client'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  canonicalTarget,
  targetKey,
  snapshot,
  mountedWorkspaceIds,
  setCustodyBrowserEnvironment,
  hasCustodyBrowserEnvironment
} from './workspace-selection-snapshot'

type Host = {
  target: RuntimeClientTarget
  client: WorktreeSelectionClient
  generation: number
  stop?: () => void
  opening: boolean
  failed: boolean
  connection?: string
  signature: string
}
const hosts = new Map<string, Host>()
type StateReader = () => AppState

function hostFor(target: RuntimeClientTarget, readState: StateReader): Host {
  const key = targetKey(target)
  let host = hosts.get(key)
  if (!host) {
    const client = new WorktreeSelectionClient(createUuidV4(), () => snapshot(target, readState()))
    const created: Host = {
      target,
      client,
      generation: 0,
      opening: false,
      failed: false,
      signature: ''
    }
    client.subscribe(() => publish(created))
    host = created
    hosts.set(key, host)
  }
  return host
}

function publish(host: Host): void {
  if (!host.client.isReady()) {
    return
  }
  const selected = host.client.selectionSnapshot()
  const workspaceIds = selected.complete ? selected.workspaceIds : []
  const signature = JSON.stringify([selected.complete, workspaceIds])
  if (host.signature === signature) {
    return
  }
  host.signature = signature
  const generation = host.generation
  void callRuntimeRpc<{ reported: boolean }>(host.target, 'workspace.selection.report.v1', {
    protocol: WORKTREE_SELECTION_CAPABILITY,
    kind: 'view',
    complete: selected.complete,
    workspaceIds
  })
    .then((result) => {
      if (result.reported !== true) {
        throw new Error('custody_selection_report_unconfirmed')
      }
    })
    .catch(() => {
      if (host.generation !== generation) {
        return
      }
      host.failed = true
      host.generation++
      const stop = host.stop
      host.stop = undefined
      host.opening = false
      host.client.disconnect()
      host.signature = ''
      stop?.()
    })
}

export function canSelectWorkspace(
  workspaceId: string,
  readState: StateReader,
  hostId?: ExecutionHostId
): boolean {
  const state = readState()
  const resolved = tryRuntimeTargetForWorktreeOwner(state, workspaceId, hostId)
  const target = resolved && canonicalTarget(resolved)
  if (!target) {
    return [...hosts.values()].every((host) => host.client.canSelect(workspaceId))
  }
  const host = hostFor(target, readState)
  return host.client.canSelect(workspaceId)
}

export function canMountWorkspace(
  workspaceId: string,
  readState: StateReader,
  hostId?: ExecutionHostId
): boolean {
  const state = readState()
  if (
    state.activeWorktreeId === workspaceId &&
    (!hostId || (state.activeWorkspaceExecutionHostId ?? 'local') === hostId)
  ) {
    return true
  }
  return canSelectWorkspace(workspaceId, readState, hostId)
}

export function ensureWorkspaceSelectionCustody(
  target: RuntimeClientTarget,
  readState: StateReader
): void {
  const canonical = canonicalTarget(target)
  if (!canonical) {
    return
  }
  target = canonical
  const host = hostFor(target, readState)
  if (host.stop || host.opening || host.failed) {
    return
  }
  host.opening = true
  const generation = ++host.generation
  const current = () => host.generation === generation
  const disconnect = () => {
    if (!current()) {
      return
    }
    const stop = host.stop
    host.generation++
    host.failed = true
    host.client.disconnect()
    host.opening = false
    host.stop = undefined
    stop?.()
  }
  const selected = snapshot(target, readState())
  host.signature = JSON.stringify([
    selected.complete,
    selected.complete ? selected.workspaceIds : []
  ])
  void subscribeRuntimeRpc(
    target,
    'workspace.selection.watch.v1',
    {
      protocol: WORKTREE_SELECTION_CAPABILITY,
      kind: 'view',
      clientIncarnation: host.client.incarnation,
      complete: selected.complete,
      workspaceIds: selected.complete ? selected.workspaceIds : [],
      pendingFences: host.client.pendingFences()
    },
    {
      onEvent: (value) => {
        if (!current()) {
          return
        }
        const parsed = SelectionFrameSchema.safeParse(value)
        if (!parsed.success) {
          disconnect()
          return
        }
        if (parsed.data.type === 'ready') {
          host.signature = ''
        }
        const ack = host.client.receive(parsed.data)
        if (parsed.data.type === 'ready') {
          void callRuntimeRpc(target, 'workspace.selection.reconcile.v1', {
            channelNonce: parsed.data.channelNonce,
            fences: host.client.pendingFences()
          }).catch(disconnect)
        } else if (parsed.data.type === 'end') {
          disconnect()
        }
        if (ack) {
          void callRuntimeRpc(target, 'workspace.selection.ack.v1', ack).catch(() => {})
        }
      },
      onError: disconnect,
      onClose: disconnect
    }
  ).then((subscription) => {
    if (!current()) {
      subscription.unsubscribe()
      return
    }
    host.opening = false
    host.stop = subscription.unsubscribe
  }, disconnect)
}

export function startWorkspaceSelectionCustody(
  store: Pick<StoreApi<AppState>, 'getState' | 'subscribe'>
): () => void {
  let stopped = false
  const reconnect = (target: RuntimeClientTarget, connection: string) => {
    if (stopped) {
      return
    }
    const host = hostFor(target, store.getState)
    if (host.connection === connection) {
      return
    }
    host.connection = connection
    const stop = host.stop
    host.generation++
    host.stop = undefined
    host.opening = false
    host.client.disconnect()
    stop?.()
    host.failed = false
    ensureWorkspaceSelectionCustody(target, store.getState)
  }
  const browserConnections = new Map<string, { identity: string; ready: boolean; epoch: number }>()
  const refresh = () => {
    const state = store.getState()
    const ids = new Set(state.activeWorktreeId ? [state.activeWorktreeId] : [])
    for (const id of mountedWorkspaceIds() ?? []) {
      ids.add(id)
    }
    for (const id of ids) {
      const target = tryRuntimeTargetForWorktreeOwner(state, id)
      if (target) {
        ensureWorkspaceSelectionCustody(target, store.getState)
      }
    }
    for (const host of hosts.values()) {
      publish(host)
    }
  }
  if (isWebClientLocation()) {
    void window.api.runtimeEnvironments.list().then(
      (environments) => {
        if (!stopped && environments.length === 1 && !hasCustodyBrowserEnvironment()) {
          setCustodyBrowserEnvironment(environments[0].id)
          ensureWorkspaceSelectionCustody(
            { kind: 'environment', environmentId: environments[0].id },
            store.getState
          )
          refresh()
        }
      },
      () => {}
    )
  } else {
    ensureWorkspaceSelectionCustody({ kind: 'local' }, store.getState)
  }
  refresh()
  const unsubscribeState = store.subscribe(refresh)
  const unsubscribeStatus = isWebClientLocation()
    ? window.api.runtimeEnvironments.onStatusChanged((event) => {
        const previous = browserConnections.get(event.environmentId)
        const ready = event.transport === 'ready' && !event.retired
        const identity = `${event.pairingRevision}:${event.remoteControl?.lastConnectedAt}`
        const changed = ready && (!previous?.ready || previous.identity !== identity)
        const epoch = (previous?.epoch ?? 0) + Number(changed)
        browserConnections.set(event.environmentId, { identity, ready, epoch })
        if (ready) {
          setCustodyBrowserEnvironment(event.environmentId)
          if (changed) {
            reconnect(
              { kind: 'environment', environmentId: event.environmentId },
              `browser:${identity}:${epoch}`
            )
          }
          refresh()
        }
      })
    : undefined
  const unsubscribe = window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.((event) => {
    if (!isWebClientLocation() && event.diagnostics.state === 'ready') {
      const target: RuntimeClientTarget = {
        kind: 'environment',
        environmentId: event.environmentId
      }
      const connection = `${event.transportGeneration}:${event.diagnostics.lastConnectedAt}`
      reconnect(target, connection)
    }
  })
  return () => {
    stopped = true
    unsubscribeState()
    unsubscribeStatus?.()
    unsubscribe?.()
    for (const host of hosts.values()) {
      host.generation++
      host.stop?.()
      host.stop = undefined
      host.opening = false
      host.client.disconnect()
    }
  }
}

export { registerMountedWorkspaceReader } from './workspace-selection-snapshot'
