import { createUuidV4 } from '../../../src/shared/uuid-v4'
import { parseRoutableExecutionHostId } from '../../../src/shared/execution-host'
import {
  SelectionAckSchema,
  SelectionReconcileSchema,
  SelectionUnsubscribeSchema,
  SelectionWatchSchema,
  WorktreeSelectionReportSchema,
  SelectionBootstrapSchema,
  WORKTREE_SELECTION_BRIDGE_CAPABILITY,
  type SelectionBootstrap
} from '../../../src/shared/worktree/custody-selection'
import { mobileWorkspaceSelection } from '../transport/workspace-selection-custody'
import {
  observeMobileSelectionHosts,
  type MobileSelectionHost
} from '../transport/workspace-selection-hosts'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcEnvelopeFields } from '../transport/rpc-envelope-fields'
import type { RpcResponse } from '../transport/types'

export type BridgeSelectionPort = {
  request(
    method: string,
    params: unknown,
    envelope?: RpcEnvelopeFields
  ): Promise<RpcResponse> | null
  subscribe(
    method: string,
    params: unknown,
    receive: (value: unknown) => void,
    envelope?: RpcEnvelopeFields
  ): (() => void) | null
}

/** Native document owner; page selection messages never open another physical channel. */
export class BridgeWorkspaceSelection implements BridgeSelectionPort {
  private readonly id = `page:${createUuidV4()}`
  private readonly hosts = new Map<string, MobileSelectionHost>()
  private readonly retiredHosts = new Set<MobileSelectionHost>()
  private readonly watches = new Map<string, { id: string; close(): void }>()
  private readonly listeners = new Set<() => void>()
  private releaseHosts: () => void = () => {}
  private readonly releaseListeners: (() => void)[] = []
  private active = true
  private capable = false
  private documentId: string | undefined
  private transport: RpcClient | null = null

  bind(transport: RpcClient): void {
    if (this.transport === transport) {
      return
    }
    for (const watch of this.watches.values()) {
      watch.close()
    }
    this.watches.clear()
    for (const host of this.hosts.values()) {
      host.views.invalidate(this.id)
      this.retiredHosts.add(host)
    }
    this.releaseHosts()
    for (const release of this.releaseListeners.splice(0)) {
      release()
    }
    this.hosts.clear()
    this.transport = transport
    this.releaseHosts = observeMobileSelectionHosts(transport, (host) => {
      this.hosts.set(host.executionHost ?? 'local', host)
      if (this.active && host.views.open(this.id)) {
        host.views.capability(this.id, this.capable)
      }
      this.releaseListeners.push(host.client.subscribe(() => this.changed()))
      this.changed()
    })
  }

  ready(capable: boolean, documentId?: string): void {
    const replaced = this.documentId !== documentId
    this.documentId = documentId
    this.capable = capable && documentId !== undefined
    if (replaced) {
      for (const watch of this.watches.values()) {
        watch.close()
      }
      this.watches.clear()
      for (const host of this.hosts.values()) {
        host.views.invalidate(this.id)
      }
    }
    this.active = true
    for (const host of this.hosts.values()) {
      if (host.views.open(this.id)) {
        host.views.capability(this.id, this.capable)
      }
    }
  }

  canInitialize(): boolean {
    return (
      this.capable ||
      [...this.hosts.values()].every((host) => host.client.pendingFences().length === 0)
    )
  }

  bootstrap(): SelectionBootstrap | undefined {
    if (!this.capable || this.hosts.size === 0) {
      return undefined
    }
    return SelectionBootstrapSchema.parse({
      protocol: WORKTREE_SELECTION_BRIDGE_CAPABILITY,
      scopes: [...this.hosts.values()]
        .filter((host) => host.client.pendingFences().length > 0)
        .map((host) => ({
          executionHost: host.executionHost ?? null,
          fences: host.client.pendingFences()
        }))
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  documentClosed(): void {
    this.active = false
    for (const watch of this.watches.values()) {
      watch.close()
    }
    this.watches.clear()
    for (const host of this.hosts.values()) {
      host.views.invalidate(this.id)
    }
  }

  dispose(): void {
    this.listeners.clear()
    this.documentClosed()
    for (const host of [...this.hosts.values(), ...this.retiredHosts]) {
      host.views.close(this.id)
    }
    this.retiredHosts.clear()
    this.releaseHosts()
    for (const release of this.releaseListeners) {
      release()
    }
  }

  request(
    method: string,
    params: unknown,
    envelope?: RpcEnvelopeFields
  ): Promise<RpcResponse> | null {
    if (
      ![
        'workspace.selection.report.v1',
        'workspace.selection.ack.v1',
        'workspace.selection.reconcile.v1',
        'workspace.selection.unsubscribe.v1'
      ].includes(method)
    ) {
      return null
    }
    return Promise.resolve().then(() => {
      const host = this.host(envelope)
      let result: unknown
      switch (method) {
        case 'workspace.selection.report.v1': {
          const report = WorktreeSelectionReportSchema.parse(params)
          if (report.kind !== 'view') {
            throw new Error('custody_selection_view_role_changed')
          }
          host.views.report(this.id, report.workspaceIds, report.complete)
          result = { reported: true }
          break
        }
        case 'workspace.selection.ack.v1':
          host.views.acknowledge(this.id, SelectionAckSchema.parse(params))
          result = { acknowledged: true }
          break
        case 'workspace.selection.reconcile.v1': {
          const reconcile = SelectionReconcileSchema.parse(params)
          host.views.reconcile(this.id, reconcile.channelNonce, reconcile.fences)
          result = { reconciled: true }
          break
        }
        default: {
          const { subscriptionId } = SelectionUnsubscribeSchema.parse(params)
          const key = host.executionHost ?? 'local'
          const watch = this.watches.get(key)
          if (watch?.id === subscriptionId) {
            watch.close()
            this.watches.delete(key)
          }
          result = { unsubscribed: watch?.id === subscriptionId }
        }
      }
      return { id: 'bridge-selection', ok: true, result }
    })
  }

  subscribe(
    method: string,
    params: unknown,
    receive: (value: unknown) => void,
    envelope?: RpcEnvelopeFields
  ): (() => void) | null {
    if (method !== 'workspace.selection.watch.v1') {
      return null
    }
    const parsed = SelectionWatchSchema.parse(params)
    const host = this.host(envelope)
    const key = host.executionHost ?? 'local'
    let subscriptionId = ''
    let nonce = ''
    const close = host.views.watch(this.id, parsed.clientIncarnation, (frame) => {
      if (frame.type === 'ready') {
        subscriptionId = frame.subscriptionId ?? ''
        nonce = frame.channelNonce
      }
      receive(frame)
    })
    const watch = { id: subscriptionId, close }
    this.watches.set(key, watch)
    try {
      host.views.report(this.id, parsed.workspaceIds, parsed.complete)
      host.views.reconcile(this.id, nonce, parsed.pendingFences)
    } catch (error) {
      close()
      this.watches.delete(key)
      throw error
    }
    return () => {
      if (this.watches.get(key) === watch) {
        this.watches.delete(key)
        close()
      }
    }
  }

  private host(envelope?: RpcEnvelopeFields): MobileSelectionHost {
    if (!this.active || !this.capable || !this.transport) {
      throw new Error('custody_selection_page_unqualified')
    }
    const rawHost = envelope?.executionHost
    if (rawHost !== undefined && typeof rawHost !== 'string') {
      throw new Error('custody_selection_page_host_invalid')
    }
    const executionHost = parseRoutableExecutionHostId(rawHost)
    if (rawHost !== undefined && (!executionHost || executionHost.kind === 'ssh')) {
      throw new Error('custody_selection_page_host_invalid')
    }
    const remote = executionHost?.kind === 'runtime' ? executionHost.id : undefined
    const client = remote ? scopeRpcClientToExecutionHost(this.transport, remote) : this.transport
    mobileWorkspaceSelection(client)
    const host = this.hosts.get(remote ?? 'local')
    if (!host) {
      throw new Error('custody_selection_page_host_unknown')
    }
    return host
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
