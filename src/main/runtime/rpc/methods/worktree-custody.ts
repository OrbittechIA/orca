import { defineMethod, defineStreamingMethod } from '../core'
import { nativeWorktreeCustody } from '../../worktree-custody-runtime'
import { WorktreeCustodyRequestSchema } from '../../../../shared/worktree/custody-schema'
import { installNativeWorktreeCustodyProvider } from '../../worktree-custody-native-provider-host'
import {
  WorktreeSelectionReportSchema,
  SelectionAckSchema,
  SelectionReconcileSchema,
  SelectionWatchSchema,
  SelectionUnsubscribeSchema
} from '../../../../shared/worktree/custody-selection'

export const WORKTREE_SELECTION_WATCH_METHOD = defineStreamingMethod({
  name: 'workspace.selection.watch.v1',
  permission: 'workspace',
  params: SelectionWatchSchema,
  handler: async (params, { runtime, connectionId, signal }, emit) => {
    if (!connectionId || signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const custody = nativeWorktreeCustody(runtime.getRuntimeId())
    const active = custody ? custody.activeClientFences() : []
    if (!active || active.length > 64) {
      throw new Error('custody_selection_native_inventory_unknown')
    }
    await new Promise<void>((resolve, reject) => {
      let close: (() => void) | undefined
      let subscriptionId = ''
      let closed = false
      const release = () => runtime.cleanupSubscription(subscriptionId)
      const cleanup = () => {
        if (closed) {
          return
        }
        closed = true
        close?.()
        signal?.removeEventListener('abort', release)
        emit({ type: 'end' })
        resolve()
      }
      try {
        close = runtime.custodySelections.watch(connectionId, params.clientIncarnation, (frame) => {
          if (frame.type === 'ready') {
            subscriptionId = `workspace-selection:${connectionId}:${params.clientIncarnation}:${frame.channelNonce}`
            emit({ ...frame, subscriptionId })
            for (const fence of active) {
              emit({ type: 'hold', channelNonce: frame.channelNonce, fence })
            }
            runtime.custodySelections.reconcile(
              connectionId,
              frame.channelNonce,
              params.pendingFences
            )
          } else {
            emit(frame)
          }
        })
        runtime.custodySelections.report(connectionId, params.workspaceIds, 'view', params.complete)
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', release, { once: true })
        if (signal?.aborted) {
          release()
        }
      } catch (error) {
        close?.()
        signal?.removeEventListener('abort', release)
        reject(error)
      }
    })
  }
})

export const WORKTREE_SELECTION_UNSUBSCRIBE_METHOD = defineMethod({
  name: 'workspace.selection.unsubscribe.v1',
  permission: 'workspace',
  params: SelectionUnsubscribeSchema,
  handler: (params, { runtime, connectionId }) => {
    if (
      !connectionId ||
      !params.subscriptionId.startsWith(`workspace-selection:${connectionId}:`)
    ) {
      return { unsubscribed: false }
    }
    return {
      unsubscribed: runtime.cleanupSubscriptionIfOwnedByConnection(
        params.subscriptionId,
        connectionId
      )
    }
  }
})

export const WORKTREE_SELECTION_ACK_METHOD = defineMethod({
  name: 'workspace.selection.ack.v1',
  permission: 'workspace',
  params: SelectionAckSchema,
  handler: (params, { runtime, connectionId }) => {
    if (!connectionId) {
      throw new Error('client_disconnected')
    }
    runtime.custodySelections.acknowledge(connectionId, params)
    return { acknowledged: true }
  }
})

export const WORKTREE_SELECTION_RECONCILE_METHOD = defineMethod({
  name: 'workspace.selection.reconcile.v1',
  permission: 'workspace',
  params: SelectionReconcileSchema,
  handler: (params, { runtime, connectionId }) => {
    if (!connectionId) {
      throw new Error('client_disconnected')
    }
    runtime.custodySelections.reconcile(connectionId, params.channelNonce, params.fences)
    return { reconciled: true }
  }
})

export const WORKTREE_SELECTION_REPORT_METHOD = defineMethod({
  name: 'workspace.selection.report.v1',
  permission: 'workspace',
  params: WorktreeSelectionReportSchema,
  handler: (params, { runtime, connectionId, signal }) => {
    if (!connectionId || signal?.aborted) {
      throw new Error('custody_selection_connection_closed')
    }
    runtime.custodySelections.report(
      connectionId,
      params.workspaceIds,
      params.kind,
      params.complete
    )
    return { reported: true }
  }
})

export const WORKTREE_CUSTODY_METHOD = defineMethod({
  name: 'worktree.custody.v1',
  permission: 'workspace',
  params: WorktreeCustodyRequestSchema,
  handler: async (params, { runtime }) => {
    const custody = nativeWorktreeCustody(runtime.getRuntimeId())
    // Hosts that skip desktop startup composition (headless/orcad) install the same provider lazily.
    installNativeWorktreeCustodyProvider(runtime)
    if (params.operation === 'list') {
      return {
        schemaVersion: 1,
        supported: custody?.supported === true,
        authorityId: custody?.authorityId ?? null,
        resources: custody?.resources() ?? [],
        complete: custody?.complete === true,
        scope: 'native-enrolled-only'
      }
    }
    if (!custody) {
      throw new Error('custody_host_unsupported')
    }
    switch (params.operation) {
      case 'observe':
        return { schemaVersion: 1, observation: await custody.observe(params.resource) }
      case 'capture':
        return { schemaVersion: 1, fence: await custody.capture(params.resource) }
      case 'check':
        custody.check(params.fence)
        return { schemaVersion: 1, valid: true }
      case 'cancel':
        await custody.cancel(params.fence)
        return { schemaVersion: 1, cancelled: true }
      case 'retire':
        return { schemaVersion: 1, outcome: await custody.retire(params.fence, params.key) }
      case 'reconcile':
        return { schemaVersion: 1, outcome: await custody.reconcile(params.resource, params.key) }
    }
  }
})
