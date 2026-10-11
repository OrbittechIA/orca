// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  stageStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt
} from './structured-agent-session-launch-prompt'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

const options = {
  prompt: 'the linked work item',
  promptDelivery: 'submit-after-ready' as const,
  launchOrigin: 'work-item-start' as const
}

function attempt() {
  const stagedPrompt = stageStructuredLaunchPrompt('session-1', options.prompt, {
    workItemStart: true,
    callerKeepsText: true,
    clientMessageId: 'message-1'
  })
  return settleStructuredAgentLaunchPrompt({
    launchResult: Promise.resolve({ sessionId: 'session-1', fence: 7 }),
    options,
    stagedPrompt,
    target: { kind: 'local' }
  })
}

describe('explicit Start recovery after operation unknown', () => {
  beforeEach(() => {
    resetStructuredAgentSessionSendsForTests()
    vi.clearAllMocks()
  })

  it('keeps the same envelope on an explicit retry and never retries automatically', async () => {
    mocks.call
      .mockResolvedValueOnce({
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'unknown' }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { submission: { dispatchState: 'accepted' } }
      })
    await expect(attempt()).resolves.toMatchObject({ delivered: false, deliveryUnknown: true })
    expect(mocks.call).toHaveBeenCalledOnce()
    await expect(attempt()).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(mocks.call).toHaveBeenCalledTimes(2)
    const first = mocks.call.mock.calls[0]?.[2]
    const retry = mocks.call.mock.calls[1]?.[2]
    expect(retry).toEqual(first)
    expect(retry).toMatchObject({
      envelope: { sessionId: 'session-1', clientOperationId: 'message-1' }
    })
    expect(retry).not.toHaveProperty('retryUnknown')
  })
})
