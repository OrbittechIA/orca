// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStructuredAgentSessionPendingSends as readOutbox } from '@/components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'

const mocks = vi.hoisted(() => ({ callStructuredAgentSession: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

import {
  stageStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt
} from './structured-agent-session-launch-prompt'

const SESSION = 'session-definitive'
const PROMPT = 'https://github.com/salvadorgu7/orca/issues/58'
const STRICT = {
  prompt: PROMPT,
  promptDelivery: 'submit-after-ready' as const,
  launchOrigin: 'work-item-start' as const
}
const SETTLED_CODES = [
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_invalid',
  'agent_session_already_resolved'
]

function settle(options: Parameters<typeof settleStructuredAgentLaunchPrompt>[0]['options']) {
  const staged = stageStructuredLaunchPrompt(SESSION, PROMPT, {
    workItemStart: true,
    callerKeepsText: true
  })
  expect(staged).not.toBeNull()
  return {
    staged,
    result: settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: SESSION, fence: 4 }),
      options,
      stagedPrompt: staged,
      target: { kind: 'local' }
    })
  }
}

describe('strict Work Item Start prompt refusal', () => {
  beforeEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.clearAllMocks()
    localStorage.clear()
  })

  it.each(SETTLED_CODES)(
    'leaves nothing queued after a %s refusal and names one fresh retry id',
    async (code) => {
      mocks.callStructuredAgentSession.mockResolvedValueOnce({
        ok: false,
        refusal: { code, message: 'settled' }
      })
      const { staged, result } = settle(STRICT)
      const outcome = await result

      expect(outcome).toMatchObject({ delivered: false, failureNotified: false })
      expect(outcome?.deliveryUnknown).toBeUndefined()
      // The ledger caches the rejection under the old id, so the retry needs a new one.
      expect(outcome?.retryClientMessageId).toEqual(expect.any(String))
      expect(outcome?.retryClientMessageId).not.toBe(staged?.clientMessageId)
      // The composer's outbox hook dispatches whatever `readOutbox` returns as `queued` on mount:
      // an empty outbox is the proof that nothing can be sent later.
      expect(readOutbox(SESSION)).toEqual([])
      expect(mocks.callStructuredAgentSession).toHaveBeenCalledTimes(1)
    }
  )

  it('settles a thrown unadmitted refusal under the same, still unused id', async () => {
    mocks.callStructuredAgentSession.mockRejectedValueOnce(
      Object.assign(new Error('structured_agent_session_unsupported'), {
        code: 'structured_agent_session_unsupported'
      })
    )
    const { staged, result } = settle(STRICT)
    const outcome = await result

    expect(outcome?.deliveryUnknown).toBeUndefined()
    expect(outcome?.retryClientMessageId).toBe(staged?.clientMessageId)
    expect(readOutbox(SESSION)).toEqual([])
  })

  it('reports a not-yet-admitted refusal as unconfirmed under the same id', async () => {
    mocks.callStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity', message: 'later' }
    })
    const { staged, result } = settle(STRICT)

    await expect(result).resolves.toMatchObject({ delivered: false, deliveryUnknown: true })
    expect(readOutbox(SESSION)).toEqual([])
    expect(staged?.clientMessageId).toEqual(expect.any(String))
  })

  it('settles a provider-rejected submission with a fresh retry id', async () => {
    mocks.callStructuredAgentSession.mockResolvedValueOnce({
      ok: true,
      value: { submission: { dispatchState: 'rejected' } }
    })
    const { staged, result } = settle(STRICT)
    const outcome = await result

    expect(outcome?.retryClientMessageId).toEqual(expect.any(String))
    expect(outcome?.retryClientMessageId).not.toBe(staged?.clientMessageId)
    expect(readOutbox(SESSION)).toEqual([])
  })
})
