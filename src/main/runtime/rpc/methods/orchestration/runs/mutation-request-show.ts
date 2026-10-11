import {
  describeMutationRequestState,
  type OrchestrationMutationRequestShowResult,
  type OrchestrationMutationRequestResult
} from '../../../../../../shared/orchestration-mutation-request'
import { defineMethod } from '../../../core'
import {
  CanonicalPromptPayloadHash,
  MutationPromptLocator,
  RequestShowParams
} from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'
import type { MutationReceiptRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { z } from 'zod'
import { readMutationRequestCurrentBinding } from './mutation-request-current-binding'

const HistoricalPromptReceipt = z.object({
  send: z.object({
    handle: z.string().min(1),
    prompt: MutationPromptLocator.extend({ processIncarnation: z.string().min(1) })
  })
})

export const ORCHESTRATION_MUTATION_REQUEST_METHODS = [
  defineMethod({
    name: 'orchestration.requestShow',
    permission: 'workspace',
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
          !callerFingerprint || !params.method
            ? []
            : params.payloadBaseHash
              ? db.findMutationReceiptsByBaseHash(
                  callerFingerprint,
                  params.method,
                  params.payloadBaseHash,
                  params.prompt
                )
              : params.payloadHash
                ? db.findMutationReceipts(
                    callerFingerprint,
                    params.method,
                    params.payloadHash,
                    params.prompt
                  )
                : []
        const candidate = rows.length === 1 ? rows[0] : undefined
        const row =
          candidate &&
          (!params.payloadBaseHash ||
            ('historicalLocatorsUnambiguous' in candidate &&
              candidate.historicalLocatorsUnambiguous === true &&
              isCanonicalHistoricalCandidate(candidate, params)))
            ? candidate
            : undefined
        const outcome = row
          ? ('matched' as const)
          : rows.length > 1
            ? ('multiple' as const)
            : ('zero' as const)
        const lookup = {
          version: 1 as const,
          outcome,
          ...(params.payloadBaseHash ? { payloadBaseHash: params.payloadBaseHash } : {})
        }
        return {
          lookup,
          ...(row ? { match: projectReceipt(runtime, row, params) } : {}),
          interpretation: row
            ? params.payloadBaseHash
              ? 'One historical receipt matches this caller, base hash and recorded terminal/incarnation. Its stored full hash is not current ownership, settlement or recovery authorization.'
              : 'One receipt matches this caller and complete canonical payload binding. A receipt is not current ownership or settlement.'
            : params.payloadBaseHash
              ? 'Zero or multiple candidate receipts remain under this caller and historical filters. Unknown history keeps the outcome ambiguous; this is not proof that nothing happened.'
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

function isCanonicalHistoricalCandidate(
  row: MutationReceiptRow,
  params: z.infer<typeof RequestShowParams>
): boolean {
  const receipt = HistoricalPromptReceipt.safeParse(
    row.receipt ? parseReceipt(row.receipt) : undefined
  )
  return Boolean(
    CanonicalPromptPayloadHash.length(129).safeParse(row.payload_hash).success &&
    receipt.success &&
    receipt.data.send.handle === params.prompt?.terminal &&
    receipt.data.send.prompt.processIncarnation === params.prompt?.processIncarnation &&
    (params.prompt?.generation === undefined ||
      receipt.data.send.prompt.generation === params.prompt.generation) &&
    (params.prompt?.provider === undefined ||
      receipt.data.send.prompt.provider === params.prompt.provider)
  )
}

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
