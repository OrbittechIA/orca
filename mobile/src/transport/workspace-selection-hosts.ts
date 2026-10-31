import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { WorktreeCustodyFence } from '../../../src/shared/worktree/custody'
import type { WorktreeSelectionClient } from '../../../src/shared/worktree/custody-selection-client'
import { workspaceSelectionScope } from './execution-host-scoped-rpc-client'
import type { RpcClient } from './rpc-client'
import type { WorkspaceSelectionViews } from './workspace-selection-views'

export type MobileSelectionHost = {
  client: WorktreeSelectionClient
  views: WorkspaceSelectionViews
  executionHost?: ExecutionHostId
  reconcile(fences: WorktreeCustodyFence[]): void
}
type Group = {
  hosts: Map<string, MobileSelectionHost>
  listeners: Set<(host: MobileSelectionHost) => void>
}
const groups = new WeakMap<RpcClient, Group>()
function group(client: RpcClient): Group {
  const root = workspaceSelectionScope(client).client
  let held = groups.get(root)
  if (!held) {
    held = { hosts: new Map(), listeners: new Set() }
    groups.set(root, held)
  }
  return held
}

export function registerMobileSelectionHost(client: RpcClient, host: MobileSelectionHost): void {
  const held = group(client)
  const key = host.executionHost ?? 'local'
  if (held.hosts.has(key)) {
    throw new Error('custody_selection_host_reused')
  }
  held.hosts.set(key, host)
  for (const listener of held.listeners) {
    listener(host)
  }
}

export function observeMobileSelectionHosts(
  client: RpcClient,
  listener: (host: MobileSelectionHost) => void
): () => void {
  const held = group(client)
  for (const host of held.hosts.values()) {
    listener(host)
  }
  held.listeners.add(listener)
  return () => {
    held.listeners.delete(listener)
  }
}
