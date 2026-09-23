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
  readOutbox,
  type StructuredAgentSessionLaunchPromptMutation
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** The host took the send but did not confirm it: uncertainty, never a refusal. */
  deliveryUnknown?: boolean
  /** Strict Start only: the host proved this attempt was not delivered, and a retry must deliver
   *  under this operation id. Reused by every later retry so they stay idempotent. */
  retryClientMessageId?: string
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
  /** A re-entered launch: its staged prompt is looked up, never re-staged. */
  recover?: { clientMessageId: string | null }
  launchOrigin?: 'work-item-start'
}

/** Only a strict Work Item Start fails closed on a refused prompt; every other launch keeps the
 *  v1.4.209 requeue. */
export function isStrictWorkItemStartPrompt(options: StructuredLaunchPromptOptions): boolean {
  return (
    options.launchOrigin === 'work-item-start' && options.promptDelivery === 'submit-after-ready'
  )
}

type DispatchOutcome = { delivered: boolean; unknown: boolean; retryClientMessageId?: string }

// Thrown before the host admitted the send, so its ledger never recorded this operation id.
const UNADMITTED_SEND_ERROR_CODES = ['structured_agent_session_unsupported', 'method_not_found']

type LaunchReceipt = { sessionId: string; fence: number }

type SharedDispatchStart = {
  promise: Promise<boolean>
  started: boolean
}

// A provisional chat can mount before its launch settlement runs. Both paths own the same
// persisted entry, so share the in-flight admission by operation id instead of issuing two RPCs.
const inFlightDispatches = new Map<string, Promise<boolean>>()

function dispatchKey(sessionId: string, clientMessageId: string, fence: number): string {
  return `${sessionId}:${clientMessageId}:${fence}`
}

export function getStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence?: number
): Promise<boolean> | undefined {
  if (fence !== undefined) {
    return inFlightDispatches.get(dispatchKey(sessionId, clientMessageId, fence))
  }
  const prefix = `${sessionId}:${clientMessageId}:`
  for (const [key, promise] of inFlightDispatches) {
    if (key.startsWith(prefix)) {
      return promise
    }
  }
  return undefined
}

export function shareStructuredAgentLaunchPromptDispatch(
  sessionId: string,
  clientMessageId: string,
  fence: number,
  start: () => Promise<boolean>
): SharedDispatchStart {
  const key = dispatchKey(sessionId, clientMessageId, fence)
  const existing = inFlightDispatches.get(key)
  if (existing) {
    return { promise: existing, started: false }
  }
  const promise = Promise.resolve().then(start)
  inFlightDispatches.set(key, promise)
  const clear = (): void => {
    if (inFlightDispatches.get(key) === promise) {
      inFlightDispatches.delete(key)
    }
  }
  void promise.then(clear, clear)
  return { promise, started: true }
}

function mutateEntry(
  entry: StructuredAgentSessionOutboxEntry,
  update: StructuredAgentSessionLaunchPromptMutation
): boolean {
  return mutateStructuredAgentSessionLaunchPrompt(entry.sessionId, entry.clientMessageId, update)
}

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt,
  target: RuntimeClientTarget,
  strict: boolean
): Promise<DispatchOutcome> {
  if (
    !mutateEntry(entry, (current) => ({
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now()
    }))
  ) {
    return { delivered: false, unknown: false }
  }
  // Strict refusal settles this launch's ONE delivery: nothing durable stays queued for the mounted
  // outbox to send behind the caller's back. The retry restages the same text under `retryId`.
  const settleStrictRefusal = (retryId: string): DispatchOutcome => {
    mutateEntry(entry, () => null)
    return { delivered: false, unknown: false, retryClientMessageId: retryId }
  }
  const freshOperationId = (): string =>
    createStructuredAgentSessionOperationId(() => crypto.randomUUID())
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(target, 'agentSession.send', structuredAgentSessionSendRequest(entry, receipt.fence))
    if (!result.ok) {
      const refusalState = agentSessionRefusalOperationState(
        'agentSession.send',
        result.refusal.code
      )
      if (strict && refusalState === 'settled-rejected') {
        // The host ledger caches this rejection under the old id, so the retry needs a new one.
        return settleStrictRefusal(freshOperationId())
      }
      // Unknown or not-yet-admitted: the same operation id is retained and replayed, never a
      // second one.
      mutateEntry(entry, (current) =>
        requeueStructuredAgentSessionSendRefusal(
          current,
          result.refusal.code,
          freshOperationId,
          entry.lastAttemptAt !== null
        )
      )
      // Strict: not-yet-admitted is unconfirmed, so its retry replays the same id rather than
      // reporting a failure the mounted outbox would later contradict by sending it.
      return {
        delivered: false,
        unknown: refusalState === 'unknown' || (strict && refusalState === 'pending-admission')
      }
    }
    const dispatchState = result.value.submission.dispatchState
    if (strict && dispatchState === 'rejected') {
      return settleStrictRefusal(freshOperationId())
    }
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
  } catch (error) {
    if (strict && UNADMITTED_SEND_ERROR_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))) {
      // Never admitted, so the same id is still unused and the retry delivers under it.
      return settleStrictRefusal(entry.clientMessageId)
    }
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
      // A retry that could neither find nor restage its operation has lost its delivery state.
      // That is not proof of non-delivery, and a fresh operation would be a second copy of the
      // prompt: report unknown so the caller reconciles instead of resending or completing.
      return args.options.recover
        ? { delivered: false, failureNotified: false, deliveryUnknown: true }
        : { delivered: false, failureNotified: true }
    }
    const entry = args.stagedEntry
    let unknown = false
    let retryClientMessageId: string | undefined
    const dispatch = shareStructuredAgentLaunchPromptDispatch(
      entry.sessionId,
      entry.clientMessageId,
      receipt.fence,
      async () => {
        const outcome = await dispatchStructuredLaunchPrompt(
          entry,
          receipt,
          args.target,
          isStrictWorkItemStartPrompt(args.options)
        )
        unknown = outcome.unknown
        retryClientMessageId = outcome.retryClientMessageId
        return outcome.delivered
      }
    )
    const delivered = await dispatch.promise
    // Why: when the mounted outbox ran the shared send, its disposition left the entry unconfirmed.
    if (!delivered && !dispatch.started) {
      unknown = readOutbox(entry.sessionId, { recoverDispatching: false }).some(
        (current) =>
          current.clientMessageId === entry.clientMessageId && current.state === 'unconfirmed'
      )
    }
    if (delivered) {
      args.options.onPromptDelivered?.()
    }
    return {
      delivered,
      failureNotified: false,
      ...(unknown ? { deliveryUnknown: true } : {}),
      ...(retryClientMessageId ? { retryClientMessageId } : {})
    }
  })
}
