// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  readOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ callStructuredAgentSession: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

import { settleStructuredAgentLaunchPrompt } from './structured-agent-session-launch-prompt'

const SESSION = 'session-definitive'
const OPTIONS = {
  prompt: 'https://github.com/salvadorgu7/orca/issues/58',
  promptDelivery: 'submit-after-ready' as const
}

describe('structured launch prompt definitive refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it.each([
    'agent_session_operation_conflict',
    'agent_session_operation_expired',
    'agent_session_operation_invalid',
    'agent_session_already_resolved'
  ])('leaves nothing queued after a %s refusal, so no mount can resend it', async (code) => {
    const staged = enqueueStructuredAgentSessionLaunchPrompt(SESSION, OPTIONS.prompt)
    expect(staged).not.toBeNull()
    mocks.callStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code, message: 'settled' }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 4 }),
        options: OPTIONS,
        stagedEntry: staged,
        target: { kind: 'local' }
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false })

    // The composer's outbox hook dispatches whatever `readOutbox` returns as `queued` on mount:
    // an empty outbox is the proof that nothing can be sent later.
    expect(readOutbox(SESSION)).toEqual([])
    expect(mocks.callStructuredAgentSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the same operation queued only for a refusal that is not definitive', async () => {
    const staged = enqueueStructuredAgentSessionLaunchPrompt(SESSION, OPTIONS.prompt)
    mocks.callStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'later' }
    })
    await settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: SESSION, fence: 4 }),
      options: OPTIONS,
      stagedEntry: staged,
      target: { kind: 'local' }
    })
    expect(readOutbox(SESSION)).toMatchObject([
      { clientMessageId: staged?.clientMessageId, state: 'queued' }
    ])
  })
})
