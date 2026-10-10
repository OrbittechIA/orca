import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StructuredLaunchAttempt } from './structured-agent-session-launch-request'
import type { AgentLaunchRequestId } from './agent-launch-request-id'

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
  /** The user action this start serves; only a re-delivery of it joins its chat. */
  requestId: AgentLaunchRequestId
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  /** Re-enter an unknown launch with its exact intent and staged prompt. Never mints. */
  recover?: StructuredAgentLaunchRecovery
  /** Adopt an existing provider conversation instead of starting a fresh one. Part of the launch's
   *  identity, not a preference — see `launchIdentity`. */
  resumeFrom?: StructuredAgentSessionResumeSource
  /** The host the route decided on; read only by the caller that starts the launch. */
  executionHostId?: ExecutionHostId
  /** The saved selection a paired host reported it will seed; read only by the starting caller. */
  hostSeedOptions?: Readonly<Record<string, string>>
  /** The tab group the chat opens in; a request with no text reuses an empty chat only there. */
  targetGroupId?: string
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
  attempt: StructuredLaunchAttempt
  entries: Set<StructuredLaunchCaller>
  promptDeliveryResults: Set<Promise<StructuredPromptDeliveryResult>>
  onSettled: () => void
}

export function createStructuredLaunchCallerGroup(
  attempt: StructuredLaunchAttempt
): StructuredLaunchCallerGroup {
  return {
    outcome: 'pending',
    attempt,
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
  target: RuntimeClientTarget
  options: StructuredAgentLaunchOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): StructuredLaunchCaller {
  const caller: StructuredLaunchCaller = {
    stagedClientMessageId: args.stagedEntry?.clientMessageId ?? null
  }
  args.group.entries.add(caller)
  const promptDeliveryResult = settleStructuredAgentLaunchPrompt({
    launchResult: args.launchResult,
    target: args.target,
    options: args.options,
    stagedEntry: args.stagedEntry
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
