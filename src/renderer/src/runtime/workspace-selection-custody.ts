import { createUuidV4 } from '../../../shared/uuid-v4'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  SelectionFrameSchema,
  WORKTREE_SELECTION_CAPABILITY
} from '../../../shared/worktree/custody-selection'
import { WorktreeSelectionClient } from '../../../shared/worktree/custody-selection-client'
import { useAppStore } from '@/store'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
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
  legacy: boolean
  connection?: string
  signature: string
}
const hosts = new Map<string, Host>()

function hostFor(target: RuntimeClientTarget): Host {
  const key = targetKey(target)
  let host = hosts.get(key)
  if (!host) {
    const client = new WorktreeSelectionClient(createUuidV4(), () => snapshot(target))
    const created: Host = {
      target,
      client,
      generation: 0,
      opening: false,
      legacy: false,
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
      host.client.disconnect()
      host.signature = ''
      host.stop?.()
      host.stop = undefined
      host.opening = false
      host.generation++
    })
}

export function canSelectWorkspace(workspaceId: string, hostId?: ExecutionHostId): boolean {
  const state = useAppStore.getState()
  const resolved = tryRuntimeTargetForWorktreeOwner(state, workspaceId, hostId)
  const target = resolved && canonicalTarget(resolved)
  if (!target) {
    return [...hosts.values()].every((host) => host.client.canSelect(workspaceId))
  }
  const host = hostFor(target)
  return host.client.canSelect(workspaceId)
}

export function canMountWorkspace(workspaceId: string, hostId?: ExecutionHostId): boolean {
  const state = useAppStore.getState()
  if (
    state.activeWorktreeId === workspaceId &&
    (!hostId || (state.activeWorkspaceExecutionHostId ?? 'local') === hostId)
  ) {
    return true
  }
  return canSelectWorkspace(workspaceId, hostId)
}

export function ensureWorkspaceSelectionCustody(target: RuntimeClientTarget): void {
  const canonical = canonicalTarget(target)
  if (!canonical) {
    return
  }
  target = canonical
  const host = hostFor(target)
  if (host.stop || host.opening || host.legacy) {
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
    host.client.disconnect()
    host.opening = false
    host.stop = undefined
    stop?.()
  }
  const selected = snapshot(target)
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
      onError: (error) => {
        if (!current()) {
          return
        }
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          host.legacy = true
        }
        disconnect()
      },
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

export function startWorkspaceSelectionCustody(): () => void {
  let stopped = false
  const refresh = () => {
    const state = useAppStore.getState()
    const ids = new Set(state.activeWorktreeId ? [state.activeWorktreeId] : [])
    for (const id of mountedWorkspaceIds() ?? []) {
      ids.add(id)
    }
    for (const id of ids) {
      const target = tryRuntimeTargetForWorktreeOwner(state, id)
      if (target) {
        ensureWorkspaceSelectionCustody(target)
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
          ensureWorkspaceSelectionCustody({
            kind: 'environment',
            environmentId: environments[0].id
          })
          refresh()
        }
      },
      () => {}
    )
  } else {
    ensureWorkspaceSelectionCustody({ kind: 'local' })
  }
  refresh()
  const unsubscribeState = useAppStore.subscribe(refresh)
  const unsubscribeStatus = isWebClientLocation()
    ? window.api.runtimeEnvironments.onStatusChanged((event) => {
        if (event.transport === 'ready' && !event.retired) {
          setCustodyBrowserEnvironment(event.environmentId)
          ensureWorkspaceSelectionCustody({
            kind: 'environment',
            environmentId: event.environmentId
          })
          refresh()
        }
      })
    : undefined
  const unsubscribe = window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.((event) => {
    if (event.diagnostics.state === 'ready') {
      const target: RuntimeClientTarget = {
        kind: 'environment',
        environmentId: event.environmentId
      }
      const host = hostFor(target)
      const connection = `${event.transportGeneration}:${event.diagnostics.lastConnectedAt}`
      if (host.connection !== connection) {
        host.connection = connection
        host.legacy = false
        ensureWorkspaceSelectionCustody(target)
      }
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
