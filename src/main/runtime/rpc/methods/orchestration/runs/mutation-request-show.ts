import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult,
  type OrchestrationMutationRequestResult
} from '../../../../../../shared/orchestration-mutation-request'
import { defineMethod } from '../../../core'
import { RequestShowParams } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'
import type { MutationReceiptRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { z } from 'zod'
import { readMutationRequestCurrentBinding } from './mutation-request-current-binding'

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineMethod({
    name: 'orchestration.requestShow',
    params: RequestShowParams,
    // Why: recovery needs a way to ask whether a mutation landed without mutating
    // again; this reads the durable receipt and never writes one, so it must stay
    // out of ORCHESTRATION_MUTATION_METHODS.
    handler: (
      params,
      { runtime, authenticatedCallerFingerprint }
    ): OrchestrationMutationRequestResult => {
      const db = runtime.getOrchestrationDb()
      // Why: receipts are keyed by caller identity; a paired client brings its own
      // fingerprint, a local caller shares the one its mutations were recorded under.
      const callerFingerprint =
        authenticatedCallerFingerprint ?? db.getLocalMutationCallerFingerprint()
      if (!params.request) {
        const rows =
          callerFingerprint && params.method && params.payloadHash
            ? db.findMutationReceipts(
                callerFingerprint,
                params.method,
                params.payloadHash,
                params.prompt
              )
            : []
        const row = rows.length === 1 ? rows[0] : undefined
        return {
          lookup: { version: 1, outcome: row ? 'matched' : rows.length ? 'multiple' : 'zero' },
          ...(row ? { match: projectReceipt(runtime, row, params) } : {}),
          interpretation: row
            ? 'One receipt matches this caller and complete canonical payload binding. A receipt is not current ownership or settlement.'
            : 'Zero or multiple receipts match under this caller. The outcome remains ambiguous; this is not proof that nothing happened.'
        }
      }
      const row = callerFingerprint
        ? db.getMutationReceipt(callerFingerprint, params.request)
        : undefined
      if (!row) {
        return {
          requestId: params.request,
          state: 'absent',
          ...(params.currentTerminal
            ? {
                currentBinding: {
                  state: 'unverifiable' as const,
                  reason: 'No receipt under this caller identity.'
                }
              }
            : {}),
          interpretation: describeMutationRequestState({
            requestId: params.request,
            state: 'absent'
          })
        }
      }
      return projectReceipt(runtime, row, params)
    }
  })
]

function projectReceipt(
  runtime: OrcaRuntimeService,
  row: MutationReceiptRow,
  params: z.infer<typeof RequestShowParams>
): OrchestrationMutationRequestShowResult {
  const receipt = row.receipt ? parseReceipt(row.receipt) : undefined
  return {
    requestId: row.request_id,
    state: row.state,
    method: row.method,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(params.currentTerminal
      ? {
          currentBinding: readMutationRequestCurrentBinding(
            runtime,
            row,
            receipt,
            params.currentTerminal,
            params.providerSessionId
          )
        }
      : {}),
    interpretation: describeMutationRequestState({
      requestId: row.request_id,
      state: row.state,
      method: row.method
    })
  }
}

function parseReceipt(receipt: string): unknown {
  try {
    return JSON.parse(receipt)
  } catch {
    return undefined
  }
}
