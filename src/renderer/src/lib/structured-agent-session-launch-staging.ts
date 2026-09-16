import {
  enqueueStructuredAgentSessionLaunchPrompt,
  findStructuredAgentSessionLaunchPromptEntry
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
 * The durable prompt operation for a launch. A re-entering launch (`recover`) FINDS the
 * operation it staged before; only a genuinely new launch stages one. `null` for a recovery
 * means the delivery state was lost, which the prompt settle reports as unknown, never as sent.
 */
export function stageLaunchPrompt(
  sessionId: string,
  options: StructuredAgentLaunchOptions
): StructuredAgentSessionOutboxEntry | null {
  const text = outboxPromptText(options)
  if (!text) {
    return null
  }
  return options.recover
    ? findStructuredAgentSessionLaunchPromptEntry(sessionId, options.recover.clientMessageId, text)
    : enqueueStructuredAgentSessionLaunchPrompt(sessionId, text)
}
