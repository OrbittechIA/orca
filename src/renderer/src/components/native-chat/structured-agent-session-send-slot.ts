import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredAgentSessionSent } from './structured-agent-session-message-sender'
// A chat's one send slot: the pending entry that draws a message as sending and keeps any other send
// of that chat out until it settles.

import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../../shared/structured-agent-session-send-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  getStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  updateStructuredAgentSessionPendingSend,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendOut,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

export type StructuredAgentSessionSendInput = {
  sessionId: string
  text: string
  /** An explicit Start retry reuses the operation its first attempt staged. */
  clientMessageId?: string
  workItemStart?: true
  attachments?: readonly StructuredAgentSessionAttachment[]
  /** Asks the host to hold it as a card while the agent works; decided once, at the send. */
  delivery?: 'queue-if-active'
  /** The caller keeps the text if it comes back, instead of the chat's composer. */
  callerKeepsText?: true
  /** Made while the chat read Stopping: drawn after that turn until the host records it. */
  sentWhileStopping?: true
  now?: number
}

/** Takes the chat's one send slot, drawn as sending; null while another send of the chat is out. */
export function takeStructuredAgentSessionSendSlot(
  input: StructuredAgentSessionSendInput
): StructuredAgentSessionPendingSend | null {
  if (structuredAgentSessionSendOut(input.sessionId)) {
    return null
  }
  const attachments = input.attachments ?? []
  const entry: StructuredAgentSessionPendingSend = {
    clientMessageId:
      input.clientMessageId ?? createStructuredAgentSessionOperationId(createBrowserUuid),
    sessionId: input.sessionId,
    body: structuredAgentSessionSendBody(input.text, attachments),
    previewUris: attachments.map((attachment) => attachment.previewUri),
    queuedAt: input.now ?? Date.now(),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.callerKeepsText ? { callerKeepsText: true as const } : {}),
    ...(input.sentWhileStopping ? { sentWhileStopping: true as const } : {}),
    ...(attachments.some((attachment) => attachment.connectionId)
      ? { imageConnectionIds: attachments.map((attachment) => attachment.connectionId ?? null) }
      : {}),
    phase: 'sending',
    issued: false
  }
  publishStructuredAgentSessionSends(input.sessionId, {
    entries: [...getStructuredAgentSessionPendingSends(input.sessionId), entry],
    // The notice explains text given back to this chat's composer; only its own sends replace it.
    ...(input.callerKeepsText ? {} : { notice: null })
  })
  return entry
}

export type StructuredAgentSessionReservedSend = {
  clientMessageId: string
  /** Sends it once the chat exists; null when the reservation was released or dropped meanwhile. */
  send: (target: RuntimeClientTarget) => StructuredAgentSessionSent | null
  /** Gives the slot back unsent. */
  release: () => void
}

export function reserveStructuredAgentSessionSend(
  input: StructuredAgentSessionSendInput,
  dispatch: (
    entry: StructuredAgentSessionPendingSend,
    target: RuntimeClientTarget,
    workItemStart?: true
  ) => StructuredAgentSessionSent
): StructuredAgentSessionReservedSend | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  if (!entry) {
    return null
  }
  // Once sent, the entry is the send's: what it keeps after settling is not the reservation's.
  let sent = false
  const held = (): StructuredAgentSessionPendingSend | undefined =>
    sent ? undefined : findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  return {
    clientMessageId: entry.clientMessageId,
    send: (target) => {
      const current = held()
      sent = true
      return current ? dispatch(current, target, input.workItemStart) : null
    },
    release: () => {
      if (held()) {
        updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, null)
      }
    }
  }
}
