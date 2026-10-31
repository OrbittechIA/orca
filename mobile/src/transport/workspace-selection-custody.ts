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

type Watch = {
  protocol: typeof WORKTREE_SELECTION_CAPABILITY
  kind: 'view'
  complete: boolean
  clientIncarnation: string
  workspaceIds: string[]
  pendingFences: WorktreeCustodyFence[]
}
type Entry = {
  client: WorktreeSelectionClient
  watch: Watch
  stop?: () => void
  signature: string
  legacy: boolean
  generation: number
}
const clients = new WeakMap<RpcClient, Entry>()

export function mobileWorkspaceSelection(client: RpcClient): WorktreeSelectionClient {
  let entry = clients.get(client)
  if (!entry) {
    const local = new WorktreeSelectionClient(createUuidV4(), () => ({
      complete: true,
      workspaceIds: []
    }))
    entry = {
      client: local,
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
      return
    }
    if (parsed.data.type === 'ready') {
      entry.signature = ''
    }
    const ack = entry.client.receive(parsed.data)
    if (parsed.data.type === 'ready') {
      void runRpcOperation(
        client,
        workspaceSelectionReconcile,
        {
          channelNonce: parsed.data.channelNonce,
          fences: entry.client.pendingFences()
        },
        { failWhenDisconnected: true }
      ).catch(() => entry.client.disconnect())
    }
    if (parsed.data.type === 'end') {
      end()
    }
    if (ack) {
      void runRpcOperation(client, workspaceSelectionAck, ack, {
        failWhenDisconnected: true
      }).catch(() => {})
    }
  })
  if (entry.generation === generation) {
    entry.stop = stop
  } else {
    stop()
  }
}
