// Shared shape for `orchestration request-show`, the read-only answer to
// "did my mutation take effect?" when the response was lost in transit.
import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentType } from './native-chat-types'

export type MutationCurrentBindingSnapshot = {
  terminal: string
  ptyId: string
  processIncarnation: string
  generation: number
  paneKey: string
  connectionId: string | null
  launchTokenHash: string
  provider: AgentType
  providerSession: AgentProviderSessionMetadata
  observedAt: number
}

export type MutationCurrentBinding = {
  state: 'observed' | 'mismatch' | 'unverifiable'
  reason: string
  snapshot?: MutationCurrentBindingSnapshot
}

export type OrchestrationMutationRequestLookupResult = {
  lookup: { version: 1; outcome: 'matched' | 'zero' | 'multiple' }
  match?: OrchestrationMutationRequestShowResult
  interpretation: string
}

export type OrchestrationMutationRequestResult =
  | OrchestrationMutationRequestShowResult
  | OrchestrationMutationRequestLookupResult

export const MUTATION_REQUEST_STATES = ['completed', 'pending', 'absent'] as const

export type OrchestrationMutationRequestState = (typeof MUTATION_REQUEST_STATES)[number]

export type OrchestrationMutationRequestShowResult = {
  requestId: string
  state: OrchestrationMutationRequestState
  method?: string
  createdAt?: string
  updatedAt?: string
  receipt?: unknown
  payloadHash?: string
  currentBinding?: MutationCurrentBinding
  // Why: `absent` is genuinely ambiguous, so the honest reading ships with the row
  // instead of being re-derived (and softened) by every caller.
  interpretation: string
}

export function describeMutationRequestState(params: {
  requestId: string
  state: OrchestrationMutationRequestState
  method?: string
}): string {
  const { requestId, state, method } = params
  if (state === 'completed') {
    return `Request ${requestId} already took effect${method ? ` (${method})` : ''}. Replaying it with --retry-request ${requestId} returns the recorded outcome and starts nothing new.`
  }
  if (state === 'pending') {
    return `Request ${requestId} was accepted${method ? ` by ${method}` : ''} but its outcome is not recorded yet. The original mutation may still be running, or Orca may have restarted before recording its outcome. Wait for the original command when it is still running; otherwise replay it with --retry-request ${requestId}. Do not issue a fresh mutation.`
  }
  return `No receipt for request ${requestId} under this caller identity. It never reached this Orca runtime, failed before recording anything, or its receipt was pruned. Absent is not proof that nothing happened.`
}
