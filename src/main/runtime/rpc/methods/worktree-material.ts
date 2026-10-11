import { defineMethod } from '../core'
import {
  WorktreeMaterialPlan,
  WorktreeMaterialRestore,
  WorktreeMaterialShow
} from '../../../../shared/rpc-contract/worktree-material-params'
import { OrchestrationError } from '../../orchestration/orchestration-error'

export const WORKTREE_MATERIAL_METHODS = [
  defineMethod({
    name: 'worktree.materialPlan',
    permission: 'workspace',
    params: WorktreeMaterialPlan,
    handler: ({ manifest }, { runtime }) => runtime.planMaterial(manifest)
  }),
  defineMethod({
    name: 'worktree.materialRestore',
    permission: 'workspace',
    params: WorktreeMaterialRestore,
    handler: async ({ manifest, requestId }, context) => {
      if (
        context.orchestrationMutation?.requestId !== requestId ||
        context.orchestrationMutation.method !== 'worktree.materialRestore'
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          'Explicit request ID and durable caller claim are required.'
        )
      }
      const plan = await context.runtime.planMaterial(manifest)
      // Complete custody census and restart admission remain unproven; no effect marker or setter.
      return { ...plan, requestId, retryAllowed: false, writerConfirmed: false }
    }
  }),
  defineMethod({
    name: 'worktree.materialShow',
    permission: 'workspace',
    params: WorktreeMaterialShow,
    handler: ({ requestId }, { runtime, authenticatedCallerFingerprint }) => {
      const db = runtime.materialReceiptDb()
      const caller = authenticatedCallerFingerprint ?? db?.getLocalMutationCallerFingerprint()
      const row = caller ? db?.getMutationReceipt(caller, requestId) : undefined
      const owned = row?.method === 'worktree.materialRestore' ? row : undefined
      return {
        requestId,
        state: !db ? 'unverifiable' : !owned ? 'absent' : owned.state,
        ...(owned ? { payloadHash: owned.payload_hash, updatedAt: owned.updated_at } : {}),
        currentMaterial: 'unverifiable',
        retryAllowed: false,
        writerConfirmed: false,
        interpretation:
          'A receipt state is historical evidence, never restoration, ownership or settlement authority.'
      }
    }
  })
]
