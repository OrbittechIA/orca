import { z } from 'zod'
import { defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'

export const workspaceSelectionReport = defineRpcOperation({
  name: 'workspace-selection.report-confirmed',
  method: 'workspace.selection.report.v1',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('reported', z.object({ reported: z.literal(true) }))
})
export const workspaceSelectionAck = defineRpcOperation({
  name: 'workspace-selection.ack-confirmed',
  method: 'workspace.selection.ack.v1',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('acknowledged', z.object({ acknowledged: z.literal(true) }))
})
export const workspaceSelectionReconcile = defineRpcOperation({
  name: 'workspace-selection.reconcile-confirmed',
  method: 'workspace.selection.reconcile.v1',
  acceptance: 'require-result-or-throw',
  barrier: 'on-settle',
  read: rpcResultVariant('reconciled', z.object({ reconciled: z.literal(true) }))
})
