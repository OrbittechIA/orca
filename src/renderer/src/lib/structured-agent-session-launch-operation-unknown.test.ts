import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({
  entry: null as StructuredAgentSessionOutboxEntry | null,
  callStructuredAgentSession: vi.fn()
}))

vi.mock('@/components/native-chat/structured-agent-session-outbox-storage', () => ({
  mutateStructuredAgentSessionLaunchPrompt: (
    _sessionId: string,
    _clientMessageId: string,
    update: (current: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry | null
  ) => {
    if (!mocks.entry) {
      return false
    }
    mocks.entry = update(mocks.entry)
    return true
  }
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

describe('structured launch prompt operation-unknown recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.entry = createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'message-1',
      sessionId: 'session-1',
      text: 'https://github.com/salvadorgu7/orca/issues/58',
      attachments: [],
      queuedAt: 1
    })
  })

  it('replays the same operation after an unknown refusal instead of minting a second one', async () => {
    mocks.callStructuredAgentSession
      .mockResolvedValueOnce({
        ok: false,
        refusal: {
          code: 'agent_session_operation_unknown',
          message: 'The original ledger outcome is unknown.'
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { submission: { dispatchState: 'accepted' } }
      })

    const first = settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 7 }),
      options: {
        prompt: 'https://github.com/salvadorgu7/orca/issues/58',
        promptDelivery: 'submit-after-ready'
      },
      stagedEntry: mocks.entry,
      target: { kind: 'local' }
    })
    await expect(first).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      deliveryUnknown: true
    })
    // Why: the host's send plan replays a recorded outcome for the same envelope, so
    // the entry keeps its operation id and stays queued; parking it would wedge the
    // outbox head (#20133).
    expect(mocks.entry).toMatchObject({
      clientMessageId: 'message-1',
      state: 'queued',
      retryAfterUnknownSubmittedAt: null
    })

    const retry = settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 7 }),
      options: {
        prompt: 'https://github.com/salvadorgu7/orca/issues/58',
        promptDelivery: 'submit-after-ready'
      },
      stagedEntry: mocks.entry,
      target: { kind: 'local' }
    })
    await expect(retry).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(mocks.callStructuredAgentSession).toHaveBeenCalledTimes(2)
    const firstRequest = mocks.callStructuredAgentSession.mock.calls[0]?.[2]
    const retryRequest = mocks.callStructuredAgentSession.mock.calls[1]?.[2]
    // Why: `retryUnknown` is a compatibility-only signal in 1.4.203; the same envelope
    // is the idempotent replay.
    expect(firstRequest).not.toHaveProperty('retryUnknown')
    expect(retryRequest).not.toHaveProperty('retryUnknown')
    expect(retryRequest).toMatchObject({
      envelope: { sessionId: 'session-1', clientOperationId: 'message-1' }
    })
    expect(retryRequest?.envelope.clientOperationId).toBe(firstRequest?.envelope.clientOperationId)
    expect(mocks.entry).toBeNull()
  })
})
