import {
  enqueueStructuredAgentSessionLaunchPrompt,
  findStructuredAgentSessionLaunchPromptEntry,
  restageStructuredAgentSessionLaunchPrompt
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import type { StructuredAgentLaunchOptions } from '@/lib/structured-agent-session-launch-callers'

/** What the outbox must carry: a draft goes to the composer seed instead. */
export function outboxPromptText(options: StructuredAgentLaunchOptions): string {
  return options.promptDelivery === 'draft' ? '' : (options.prompt?.trim() ?? '')
}

export function joinLaunchDelivery(
  options: StructuredAgentLaunchOptions,
  established: StructuredAgentLaunchOptions['promptDelivery']
): StructuredAgentLaunchOptions {
  // Why: the first caller's mode wins, but with none established an absent mode reads as submit —
  // that would send a joiner's draft it never consented to send.
  const mode = established ?? options.promptDelivery
  const { promptDelivery: _joinerMode, ...rest } = options
  return mode ? { ...rest, promptDelivery: mode } : rest
}

/**
 * The durable prompt operation for a launch. A re-entering launch (`recover`) reuses the operation
 * it staged before, restaging it under that SAME id when the entry is gone: the host ledger replays
 * an id it already accepted, so the prompt is delivered at most once. `null` for a recovery means
 * no id survived, which the prompt settle reports as unknown, never as sent.
 */
export function stageLaunchPrompt(
  sessionId: string,
  options: StructuredAgentLaunchOptions
): StructuredAgentSessionOutboxEntry | null {
  const text = outboxPromptText(options)
  if (!text) {
    return null
  }
  if (!options.recover) {
    return enqueueStructuredAgentSessionLaunchPrompt(sessionId, text)
  }
  const { clientMessageId } = options.recover
  return clientMessageId
    ? restageStructuredAgentSessionLaunchPrompt(sessionId, clientMessageId, text)
    : findStructuredAgentSessionLaunchPromptEntry(sessionId, null, text)
}

/** A strict launch retried after its create failed never dispatched its staged prompt, so the retry
 *  delivers that same entry; staging only when none survived keeps it at one copy. */
export function stageStrictRetryPrompt(
  sessionId: string,
  options: StructuredAgentLaunchOptions
): StructuredAgentSessionOutboxEntry | null {
  const text = outboxPromptText(options)
  if (!text) {
    return null
  }
  return (
    findStructuredAgentSessionLaunchPromptEntry(sessionId, null, text) ??
    enqueueStructuredAgentSessionLaunchPrompt(sessionId, text)
  )
}
