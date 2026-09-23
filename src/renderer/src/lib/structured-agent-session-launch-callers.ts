import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'

/**
 * What a launch with an unknown outcome leaves behind for its retry: the EXACT intent (session
 * id, create envelope, owner runtime) and the operation id of the prompt it staged. A retry
 * re-enters with these and mints nothing — the host replays the same create and the same send.
 */
export type StructuredAgentLaunchRecovery = {
  intent: StructuredAgentSessionLaunchIntent
  /** Null when the launch staged no prompt (draft, or no text). */
  clientMessageId: string | null
}

export type StructuredAgentLaunchOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  /** Re-enter an unknown launch with its exact intent and staged prompt. Never mints. */
  recover?: StructuredAgentLaunchRecovery
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Declara o create ESCOPADO do Work Item Start; o host o admite por capability própria. */
  launchOrigin?: 'work-item-start'
}

export type StructuredLaunchCaller = {
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  /** The prompt operation this caller staged (or re-entered with); null without a prompt. */
  stagedClientMessageId: string | null
}

export type StructuredLaunchCallerGroup = {
  outcome: 'pending' | 'published' | 'failed' | 'unknown' | 'cancelled'
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(): StructuredLaunchCallerGroup {
  return {
    outcome: 'pending',
    entries: new Set(),
    promptDeliveryResults: new Set(),
    onSettled: () => {}
  }
}

function trackPromptDelivery(
  group: StructuredLaunchCallerGroup,
  promptDeliveryResult: Promise<StructuredPromptDeliveryResult>
): void {
  group.promptDeliveryResults.add(promptDeliveryResult)
  const settled = (): void => {
    group.promptDeliveryResults.delete(promptDeliveryResult)
    group.onSettled()
  }
  void promptDeliveryResult.then(settled, settled)
}

export function addStructuredLaunchCaller(args: {
  group: StructuredLaunchCallerGroup
  launchResult: Promise<{ sessionId: string; fence: number }>
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
  /** O runtime dono da sessão; a entrega segue o mesmo caminho do create. */
  target: RuntimeClientTarget
}): StructuredLaunchCaller {
  const caller: StructuredLaunchCaller = {
    stagedClientMessageId: args.stagedEntry?.clientMessageId ?? null
  }
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
    options: args.options,
    stagedEntry: args.stagedEntry,
    target: args.target
  })
  caller.promptDeliveryResult = promptDeliveryResult?.catch(() => ({
    delivered: false,
    failureNotified: true
  }))
  if (caller.promptDeliveryResult) {
    trackPromptDelivery(args.group, caller.promptDeliveryResult)
  }
  return caller
}

export function settleStructuredLaunchCallers(
  group: StructuredLaunchCallerGroup,
  outcome: 'published' | 'failed' | 'cancelled'
): void {
  group.outcome = outcome
  group.onSettled()
}

export function releaseStructuredLaunchCallerAfterUnknownOutcome(
  group: StructuredLaunchCallerGroup,
  caller: StructuredLaunchCaller
): boolean {
  if (group.outcome !== 'unknown' || !group.entries.delete(caller)) {
    return false
  }
  group.onSettled()
  return true
}

export function structuredLaunchCallersHavePendingWork(
  group: StructuredLaunchCallerGroup
): boolean {
  return (
    group.outcome === 'pending' ||
    group.outcome === 'unknown' ||
    group.promptDeliveryResults.size > 0
  )
}
