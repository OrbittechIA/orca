import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  mutateStructuredAgentSessionLaunchPrompt,
  type StructuredAgentSessionLaunchPromptMutation
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** O host aceitou o envio mas não confirmou: incerteza, nunca recusa. */
  deliveryUnknown?: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }

function mutateEntry(
  entry: StructuredAgentSessionOutboxEntry,
  update: StructuredAgentSessionLaunchPromptMutation
): boolean {
  return mutateStructuredAgentSessionLaunchPrompt(entry.sessionId, entry.clientMessageId, update)
}

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget
): Promise<{ delivered: boolean; unknown: boolean }> {
  if (
    !mutateEntry(entry, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    }))
  ) {
    return { delivered: false, unknown: false }
  }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(target, 'agentSession.send', structuredAgentSessionSendRequest(entry, receipt.fence))
    if (!result.ok) {
      mutateEntry(entry, (current) =>
        requeueStructuredAgentSessionSendRefusal(
          current,
          result.refusal.code,
          () => createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
          entry.lastAttemptAt !== null
        )
      )
      // Uma recusa cujo desfecho o host não conhece é incerteza, não negativa.
      return {
        delivered: false,
        unknown:
          agentSessionRefusalOperationState('agentSession.send', result.refusal.code) === 'unknown'
      }
    }
    const dispatchState = result.value.submission.dispatchState
    mutateEntry(entry, (current) =>
      dispatchState === 'accepted'
        ? null
        : {
            ...current,
            state:
              dispatchState === 'unknown'
                ? 'unconfirmed'
                : dispatchState === 'pending'
                  ? 'dispatching'
                  : 'queued'
          }
    )
    return {
      delivered: dispatchState === 'accepted' || dispatchState === 'pending',
      unknown: dispatchState === 'unknown'
    }
  } catch {
    mutateEntry(entry, (current) => ({ ...current, state: 'unconfirmed' }))
    return { delivered: false, unknown: true }
  }
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  options: StructuredLaunchPromptOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
  target: RuntimeClientTarget
}): Promise<StructuredPromptDeliveryResult> | undefined {
  // Why: a draft has no delivery event — the composer adopts it and the user sends it — so
  // `onPromptDelivered` never fires and no result is reported.
  if (args.options.promptDelivery === 'draft' || !args.options.prompt?.trim()) {
    return undefined
  }
  return args.launchResult.then(async (receipt) => {
    if (!args.stagedEntry) {
      return { delivered: false, failureNotified: true }
    }
    const { delivered, unknown } = await dispatchStructuredLaunchPrompt(
      args.stagedEntry,
      receipt,
      args.target
    )
    if (delivered) {
      args.options.onPromptDelivered?.()
    }
    return { delivered, failureNotified: false, ...(unknown ? { deliveryUnknown: true } : {}) }
  })
}
