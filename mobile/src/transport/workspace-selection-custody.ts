import { createUuidV4 } from '../../../src/shared/uuid-v4'
import { WorktreeSelectionClient } from '../../../src/shared/worktree/custody-selection-client'
import {
  SelectionFrameSchema,
  WORKTREE_SELECTION_CAPABILITY
} from '../../../src/shared/worktree/custody-selection'
import type { WorktreeCustodyFence } from '../../../src/shared/worktree/custody'
import type { RpcClient } from './rpc-client'
import { runRpcOperation } from './rpc-operation'
import {
  workspaceSelectionReport,
  workspaceSelectionAck,
  workspaceSelectionReconcile
} from './workspace-selection-operations'
import { WorkspaceSelectionViews } from './workspace-selection-views'
import { registerMobileSelectionHost, type MobileSelectionHost } from './workspace-selection-hosts'
import { workspaceSelectionScope } from './execution-host-scoped-rpc-client'

type Watch = {
  protocol: typeof WORKTREE_SELECTION_CAPABILITY
  kind: 'view'
  complete: boolean
  clientIncarnation: string
  workspaceIds: string[]
  pendingFences: WorktreeCustodyFence[]
}
type Entry = MobileSelectionHost & {
  watch: Watch
  stop?: () => void
  signature: string
  legacy: boolean
  generation: number
  channelNonce?: string
}
const clients = new WeakMap<RpcClient, Entry>()

export function mobileWorkspaceSelection(client: RpcClient): WorktreeSelectionClient {
  let entry = clients.get(client)
  if (!entry) {
    const views = new WorkspaceSelectionViews({
      changed: () => local.refresh(),
      fences: () => local.pendingFences(),
      reconcile: (fences) => current.reconcile(fences)
    })
    const local = new WorktreeSelectionClient(createUuidV4(), () => views.snapshot())
    const scope = workspaceSelectionScope(client)
    const bootstrap = client.getWorkspaceSelectionBootstrap?.()
    if (bootstrap) {
      const fences =
        bootstrap.scopes.find((value) => value.executionHost === (scope.executionHost ?? null))
          ?.fences ?? []
      if (!local.seed(fences)) {
        throw new Error('custody_selection_bootstrap_overflow')
      }
    }
    entry = {
      client: local,
      views,
      executionHost: scope.executionHost,
      reconcile: (fences) => {
        const nonce = current.channelNonce
        if (nonce && local.isReady()) {
          void runRpcOperation(
            client,
            workspaceSelectionReconcile,
            { channelNonce: nonce, fences },
            { failWhenDisconnected: true }
          ).catch(() => local.disconnect())
        }
      },
      signature: '',
      legacy: false,
      generation: 0,
      watch: {
        protocol: WORKTREE_SELECTION_CAPABILITY,
        kind: 'view',
        complete: true,
        clientIncarnation: local.incarnation,
        workspaceIds: [],
        pendingFences: []
      }
    }
    clients.set(client, entry)
    const current = entry
    local.subscribe(() => publish(client, current))
    registerMobileSelectionHost(client, entry)
    client.onStateChange((state) => {
      if (state !== 'connected') {
        current.signature = ''
        local.disconnect()
      } else if (!current.stop) {
        current.legacy = false
        start(client, current)
      }
    })
  }
  if (!entry.stop && !entry.legacy) {
    start(client, entry)
  }
  return entry.client
}

function publish(client: RpcClient, entry: Entry): void {
  const selected = entry.client.selectionSnapshot()
  entry.watch.workspaceIds = selected.complete ? [...selected.workspaceIds] : []
  entry.watch.complete = selected.complete
  entry.watch.pendingFences = entry.client.pendingFences()
  if (!entry.client.isReady()) {
    return
  }
  const signature = JSON.stringify([selected.complete, entry.watch.workspaceIds])
  if (signature === entry.signature) {
    return
  }
  entry.signature = signature
  void runRpcOperation(
    client,
    workspaceSelectionReport,
    {
      protocol: WORKTREE_SELECTION_CAPABILITY,
      kind: 'view',
      complete: selected.complete,
      workspaceIds: entry.watch.workspaceIds
    },
    { failWhenDisconnected: true }
  ).catch(() => {
    entry.signature = ''
    entry.client.disconnect()
  })
}

function start(client: RpcClient, entry: Entry): void {
  const generation = ++entry.generation
  const end = () => {
    if (entry.generation !== generation) {
      return
    }
    entry.generation++
    entry.client.disconnect()
    const stop = entry.stop
    entry.stop = undefined
    stop?.()
  }
  const selected = entry.client.selectionSnapshot()
  entry.watch.workspaceIds = selected.complete ? [...selected.workspaceIds] : []
  entry.watch.complete = selected.complete
  entry.watch.pendingFences = entry.client.pendingFences()
  entry.signature = JSON.stringify([selected.complete, entry.watch.workspaceIds])
  const stop = client.subscribe('workspace.selection.watch.v1', entry.watch, (value) => {
    if (entry.generation !== generation) {
      return
    }
    const parsed = SelectionFrameSchema.safeParse(value)
    if (!parsed.success) {
      if (
        typeof value === 'object' &&
        value !== null &&
        'error' in value &&
        typeof value.error === 'object' &&
        value.error !== null &&
        'code' in value.error &&
        value.error.code === 'method_not_found'
      ) {
        entry.legacy = true
      }
      end()
      if (
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === 'error' &&
        'message' in value &&
        value.message === 'the shell ended this stream (closed)' &&
        client.getWorkspaceSelectionBootstrap &&
        !entry.legacy &&
        client.getState() === 'connected'
      ) {
        queueMicrotask(() => {
          if (!entry.stop && !entry.legacy) {
            start(client, entry)
          }
        })
      }
      return
    }
    if (parsed.data.type === 'ready') {
      entry.signature = ''
      entry.channelNonce = parsed.data.channelNonce
    }
    const native =
      (parsed.data.type === 'hold' || parsed.data.type === 'settled') &&
      entry.client.ownsChannel(parsed.data.channelNonce)
    const ack = entry.client.receive(parsed.data)
    if (native) {
      entry.views.native(parsed.data)
    }
    if (parsed.data.type === 'ready') {
      entry.reconcile(entry.client.pendingFences())
    }
    if (parsed.data.type === 'end') {
      end()
    }
    if (ack) {
      const viewsVersion = entry.views.version
      void entry.views
        .round(ack)
        .then((disposition) => {
          if (entry.generation === generation) {
            const final =
              entry.views.version !== viewsVersion
                ? 'unknown'
                : ack.disposition === 'absent'
                  ? disposition
                  : ack.disposition
            return runRpcOperation(
              client,
              workspaceSelectionAck,
              { ...ack, disposition: final },
              {
                failWhenDisconnected: true
              }
            )
          }
        })
        .catch(() => {})
    }
  })
  if (entry.generation === generation) {
    entry.stop = stop
  } else {
    stop()
  }
}
