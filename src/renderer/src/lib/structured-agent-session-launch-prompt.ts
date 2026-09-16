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
  /** A re-entered launch: its staged prompt is looked up, never re-staged. */
  recover?: { clientMessageId: string | null }
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
      const refusalState = agentSessionRefusalOperationState(
        'agentSession.send',
        result.refusal.code
      )
      if (refusalState === 'settled-rejected') {
        // A definitive refusal settles this launch's ONE delivery. The composer's requeue would
        // mint a fresh operation and leave it queued, and the outbox hook sends whatever is
        // queued the moment the chat mounts — a second writer the strict caller already said no
        // to. Nothing durable remains, so no later mount or reconcile can send it.
        mutateEntry(entry, () => null)
        return { delivered: false, unknown: false }
      }
      // Unknown or not-yet-admitted: the same operation id is retained and replayed, never a
      // second one.
      mutateEntry(entry, (current) =>
        requeueStructuredAgentSessionSendRefusal(
          current,
          result.refusal.code,
          () => createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
          entry.lastAttemptAt !== null
        )
      )
      // Uma recusa cujo desfecho o host não conhece é incerteza, não negativa.
      return { delivered: false, unknown: refusalState === 'unknown' }
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
      // A retry that cannot find the operation it staged has lost its delivery state. That is
      // not proof of non-delivery, and a fresh operation would be a second copy of the prompt:
      // report unknown so the caller reconciles instead of resending or completing.
      return args.options.recover
        ? { delivered: false, failureNotified: false, deliveryUnknown: true }
        : { delivered: false, failureNotified: true }
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
