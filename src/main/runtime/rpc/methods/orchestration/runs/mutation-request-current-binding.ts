import { z } from 'zod'
import type { MutationCurrentBinding } from '../../../../../../shared/orchestration-mutation-request'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { MutationReceiptRow } from '../../../../orchestration/types'
import {
  hashCanonical,
  readPromptBindingPayloadHash
} from '../../../orchestration-mutation-receipt'
import { CanonicalPromptPayloadHash } from '../../../../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'

const PromptReceipt = z.object({
  send: z.object({
    prompt: z.object({
      processIncarnation: z.string().min(1),
      generation: z.number().int().nonnegative(),
      provider: z.enum(['claude', 'codex', 'unsupported', 'old-host'])
    })
  })
})

export function readMutationRequestCurrentBinding(
  runtime: OrcaRuntimeService,
  row: MutationReceiptRow,
  receipt: unknown,
  terminal: string,
  providerSessionId?: string
): MutationCurrentBinding {
  const prompt = PromptReceipt.safeParse(receipt)
  const recordedBinding = readPromptBindingPayloadHash(row.payload_hash)
  const observedAfter = Date.parse(`${row.created_at.replace(' ', 'T')}Z`)
  if (
    row.method !== 'terminal.send' ||
    !prompt.success ||
    !CanonicalPromptPayloadHash.safeParse(row.payload_hash).success ||
    !recordedBinding ||
    !Number.isFinite(observedAfter)
  ) {
    return { state: 'unverifiable', reason: 'Receipt lacks a canonical prompt binding.' }
  }
  let snapshot: ReturnType<OrcaRuntimeService['getTerminalPromptCurrentBinding']>
  try {
    snapshot = runtime.getTerminalPromptCurrentBinding(terminal, observedAfter)
  } catch {
    return { state: 'unverifiable', reason: 'Current terminal binding is unavailable.' }
  }
  if (!snapshot) {
    return {
      state: 'unverifiable',
      reason: 'No unique live pane/connection/launch/session evidence.'
    }
  }
  const bindingHash = hashCanonical({
    ptyId: snapshot.ptyId,
    processIncarnation: snapshot.processIncarnation,
    generation: snapshot.generation
  })
  const historical = prompt.data.send.prompt
  if (
    bindingHash !== recordedBinding ||
    snapshot.processIncarnation !== historical.processIncarnation ||
    snapshot.generation !== historical.generation ||
    snapshot.provider !== historical.provider ||
    (providerSessionId !== undefined && snapshot.providerSession.id !== providerSessionId)
  ) {
    return {
      state: 'mismatch',
      reason: 'Current binding differs from the receipt or expected session.',
      snapshot
    }
  }
  return {
    state: 'observed',
    reason:
      'Current native binding observed; this is not settlement or proof of historical session continuity.',
    snapshot
  }
}
