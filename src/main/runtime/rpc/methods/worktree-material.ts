import { acquireMaterialMutation } from '../../runtime-worktree-material-admission'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DurableMutationInvocation } from '../orchestration-mutation-executor'
import { hashCanonical, attachMutationReceipt } from '../orchestration-mutation-receipt'
import { defineMethod } from '../core'
import {
  WorktreeMaterialPlan,
  WorktreeMaterialRestore,
  WorktreeMaterialShow,
  MaterialRestoredReceipt
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
      if (!context.markMutationEffectPossible) {
        throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
      }
      return context.runtime.restoreMaterial(
        manifest,
        requestId,
        context.markMutationEffectPossible
      )
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
      let restored
      if (
        owned?.state === 'completed' &&
        owned.receipt &&
        Buffer.byteLength(owned.receipt) <= 32_768
      ) {
        try {
          const parsed = MaterialRestoredReceipt.safeParse(JSON.parse(owned.receipt))
          if (parsed.success && parsed.data.requestId === requestId) {
            restored = parsed.data
          }
        } catch {
          /* Corrupt historical evidence is never a retry instruction. */
        }
      }
      return {
        requestId,
        state: !db
          ? 'unverifiable'
          : !owned
            ? 'absent'
            : owned.state === 'completed' && !restored
              ? 'unverifiable'
              : owned.state,
        ...(restored ? { receipt: restored } : {}),
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

export async function executeMaterialRestoreRequest(
  runtime: OrcaRuntimeService,
  inFlight: Map<string, { method: string; payloadHash: string; promise: Promise<unknown> }>,
  identity: DurableMutationInvocation['identity'],
  params: unknown,
  invoke: (mutation?: DurableMutationInvocation) => unknown
): Promise<unknown> {
  const input = WorktreeMaterialRestore.parse(params)
  const { requestId, callerFingerprint, method, payloadHash } = identity
  if (input.requestId !== requestId) {
    throw new OrchestrationError(
      'request_mismatch',
      'Explicit request ID differs from the durable envelope.'
    )
  }
  const key = `${callerFingerprint}:${requestId}`
  const active = inFlight.get(key)
  if (active) {
    if (active.method !== method || active.payloadHash !== payloadHash) {
      throw new OrchestrationError('request_mismatch', 'Material request payload differs.')
    }
    return attachMutationReceipt(await active.promise, requestId, true)
  }
  const db = runtime.getOrchestrationDb()
  const unknown = () =>
    new OrchestrationError(
      'operation_unknown',
      'Material outcome is unproven. Inspect material-show with this request ID; never repeat restoration.',
      { requestId }
    )
  const validate = (value: unknown) => {
    const receipt = MaterialRestoredReceipt.parse(value)
    if (
      receipt.requestId !== requestId ||
      hashCanonical(receipt.manifest) !== hashCanonical(input.manifest)
    ) {
      throw unknown()
    }
    return receipt
  }
  const replay = (row: NonNullable<ReturnType<typeof db.getMutationReceipt>>) => {
    if (row.method !== method || row.payload_hash !== payloadHash) {
      throw new OrchestrationError('request_mismatch', 'Material request payload differs.')
    }
    if (row.state !== 'completed' || !row.receipt || Buffer.byteLength(row.receipt) > 32_768) {
      throw unknown()
    }
    try {
      return attachMutationReceipt(validate(JSON.parse(row.receipt)), requestId, true)
    } catch {
      throw unknown()
    }
  }
  const previous = db.getMutationReceipt(callerFingerprint, requestId)
  if (previous) {
    return replay(previous)
  }
  const permit = acquireMaterialMutation(
    runtime.materialAdmissionAuthority,
    identity,
    input.manifest
  )
  let promise!: Promise<unknown>
  promise = Promise.resolve().then(async (): Promise<unknown> => {
    let effectPossible = false
    try {
      const begun = db.beginMutationReceipt({ ...identity, material: input.manifest })
      if (begun.disposition !== 'started') {
        return replay(begun.row)
      }
      const result = await permit.run(() =>
        invoke({
          identity,
          recordReceipt: () => {
            throw new Error('E_MATERIAL_EARLY_RECEIPT_FORBIDDEN')
          },
          markWorkerDoneEffectFree: () => {
            throw new Error('E_MATERIAL_CHECKPOINT_FORBIDDEN')
          },
          markEffectPossible: () => {
            effectPossible = true
          }
        })
      )
      const receipted = attachMutationReceipt(validate(result), requestId, false)
      db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(receipted) })
      return receipted
    } catch (error) {
      if (effectPossible) {
        throw unknown()
      }
      throw error
    } finally {
      if (inFlight.get(key)?.promise === promise) {
        inFlight.delete(key)
      }
      permit.release()
    }
  })
  inFlight.set(key, { method, payloadHash, promise })
  return promise
}
