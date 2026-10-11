import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult,
  AgentSessionWireRefusalCode
} from '../../../../shared/agent-session-wire'
import { refuseUnclassified } from '../../../../shared/agent-session-wire-refusals'
import {
  structuredAgentSessionSendBody,
  structuredAgentSessionMessageSendMutation
} from '../../../../shared/structured-agent-session-send-mutation'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../../shared/structured-agent-session-send-evidence'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  handBack: vi.fn(),
  uuid: vi.fn(() => '12345678-1234-1234-1234-123456789abc')
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: vi.fn(async (): Promise<void> => undefined)
}))
vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: mocks.uuid }))

import {
  finishWorkItemStartSend,
  workItemStartSendDisposition,
  type WorkItemStartSendDisposition
} from './work-item-start-send-disposition'
import {
  STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS,
  dropStructuredAgentSessionSends,
  reserveStructuredAgentSessionSend,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal
} from './structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from './structured-agent-session-send-attempt'

const SESSION = 'start-session'
const ORIGINAL_ID = '1770000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TEXT = 'Start the linked work item'
const target = { kind: 'local' } as const

function submission(
  dispatchState: AgentJournalSubmission['dispatchState'],
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId: ORIGINAL_ID,
    fence: 7,
    payloadFingerprint: 'a'.repeat(64),
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    ...extra
  }
}

function accepted(
  value: AgentSessionSendResult
): AgentSessionMutationResult<AgentSessionSendResult> {
  return { ok: true, replayed: false, fence: 7, cursor: { epoch: 'e', sequence: 1 }, value }
}

function answerFor(dispatchState: AgentJournalSubmission['dispatchState']) {
  return accepted({ clientMessageId: ORIGINAL_ID, submission: submission(dispatchState) })
}

function sendStart(sessionId = SESSION) {
  const sent = sendStructuredAgentSessionMessage({
    sessionId,
    target,
    text: TEXT,
    clientMessageId: ORIGINAL_ID,
    workItemStart: true,
    callerKeepsText: true
  })
  if (!sent?.workItemStartOutcome) {
    throw new Error('Strict send was not reserved')
  }
  return { ...sent, workItemStartOutcome: sent.workItemStartOutcome }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStructuredAgentSessionSendsForTests()
  noteStructuredAgentSessionFence(SESSION, 7)
})

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  vi.useRealTimers()
})

describe('Work Item Start send evidence', () => {
  it.each(['accepted', 'pending'] as const)('confirms a %s submission', (state) => {
    expect(workItemStartSendDisposition({ kind: 'result', result: answerFor(state) })).toBe(
      'delivered'
    )
  })

  it('confirms a host-owned queued message', () => {
    const result = accepted({
      clientMessageId: ORIGINAL_ID,
      queued: { messageId: ORIGINAL_ID, position: 0, state: 'waiting' }
    })
    expect(workItemStartSendDisposition({ kind: 'result', result })).toBe('delivered')
  })

  it('keeps unknown and missing durable submissions ambiguous', () => {
    for (const row of [
      submission('unknown'),
      submission('accepted', { reason: STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING })
    ]) {
      const result = accepted({ clientMessageId: ORIGINAL_ID, submission: row })
      expect(workItemStartSendDisposition({ kind: 'result', result })).toBe('unknown')
    }
  })

  it.each([
    ['agent_session_operation_conflict', 'rejected'],
    ['agent_session_operation_expired', 'rejected'],
    ['agent_session_operation_invalid', 'rejected'],
    ['agent_session_operation_unknown', 'unknown'],
    ['agent_session_operation_capacity', 'unknown'],
    ['structured_agent_session_unsupported', 'unknown']
  ] satisfies readonly (readonly [AgentSessionWireRefusalCode, WorkItemStartSendDisposition])[])(
    'classifies the returned %s refusal',
    (code, disposition) => {
      expect(
        workItemStartSendDisposition({
          kind: 'result',
          result: { ok: false, refusal: refuseUnclassified(code, code) }
        })
      ).toBe(disposition)
    }
  )

  it.each(['structured_agent_session_unsupported', 'method_not_found'])(
    'retains the unused id after a thrown %s',
    (code) => {
      expect(
        workItemStartSendDisposition({
          kind: 'thrown',
          error: Object.assign(new Error(code), { code }),
          rpcCode: undefined
        })
      ).toBe('unused')
    }
  )

  it.each(['runtime_timeout', 'unauthorized', 'agent_session_operation_conflict'])(
    'keeps every other thrown %s ambiguous',
    (code) => {
      expect(
        workItemStartSendDisposition({
          kind: 'thrown',
          error: Object.assign(new Error(code), { code }),
          rpcCode: code
        })
      ).toBe('unknown')
    }
  )

  it('checks an explicit thrown refusal before wrapper prose', () => {
    for (const code of [
      'structured_agent_session_unsupported',
      'agent_session_operation_conflict'
    ] as const) {
      const error = Object.assign(new Error('structured_agent_session_unsupported'), {
        response: { error: { data: { refusal: refuseUnclassified(code, code) } } }
      })
      expect(workItemStartSendDisposition({ kind: 'thrown', error, rpcCode: undefined })).toBe(
        code === 'structured_agent_session_unsupported' ? 'unused' : 'unknown'
      )
    }
  })

  it('mints a retry id only for a settled rejection', () => {
    const createRetryId = vi.fn(() => 'next-id')
    for (const disposition of ['delivered', 'unused', 'unknown', 'cancelled'] as const) {
      finishWorkItemStartSend(disposition, ORIGINAL_ID, createRetryId)
    }
    expect(createRetryId).not.toHaveBeenCalled()
    expect(finishWorkItemStartSend('rejected', ORIGINAL_ID, createRetryId)).toEqual({
      delivered: false,
      retryClientMessageId: 'next-id'
    })
    expect(createRetryId).toHaveBeenCalledOnce()
  })
})

describe('Work Item Start uses the existing sender once', () => {
  it('exposes a reserved identity before sending and uses the current send fingerprint', async () => {
    mocks.call.mockResolvedValue(answerFor('accepted'))
    const reserved = reserveStructuredAgentSessionSend({
      sessionId: SESSION,
      text: TEXT,
      clientMessageId: ORIGINAL_ID,
      workItemStart: true,
      callerKeepsText: true
    })
    expect(reserved?.clientMessageId).toBe(ORIGINAL_ID)
    expect(mocks.call).not.toHaveBeenCalled()
    const sent = reserved?.send(target)
    await expect(sent?.workItemStartOutcome).resolves.toEqual({ delivered: true })
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      target,
      'agentSession.send',
      structuredAgentSessionMessageSendMutation({
        sessionId: SESSION,
        clientOperationId: ORIGINAL_ID,
        expectedRuntimeFence: 7,
        body: structuredAgentSessionSendBody(TEXT, [])
      })
    )
    expect(reserved?.send(target)).toBeNull()
    expect(mocks.uuid).not.toHaveBeenCalled()
  })

  it('retains the original id on unknown and never retries automatically', async () => {
    mocks.call.mockResolvedValue(answerFor('unknown'))
    const sent = sendStart()
    await expect(sent.workItemStartOutcome).resolves.toEqual({
      delivered: false,
      deliveryUnknown: true
    })
    await flush()
    expect(sent.clientMessageId).toBe(ORIGINAL_ID)
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.uuid).not.toHaveBeenCalled()
  })

  it.each(['structured_agent_session_unsupported', 'method_not_found', 'runtime_timeout'])(
    'keeps a thrown %s on its original identity',
    async (code) => {
      mocks.call.mockRejectedValue(Object.assign(new Error(code), { code }))
      const sent = sendStart()
      await expect(sent.workItemStartOutcome).resolves.toEqual(
        code === 'runtime_timeout'
          ? { delivered: false, deliveryUnknown: true }
          : { delivered: false, retryClientMessageId: ORIGINAL_ID }
      )
      expect(mocks.call).toHaveBeenCalledOnce()
      expect(mocks.uuid).not.toHaveBeenCalled()
    }
  )

  it('keeps a thrown history read unknown without dispatching a mutation', async () => {
    resetStructuredAgentSessionSendsForTests()
    mocks.call.mockRejectedValue(new Error('connection refused'))
    const sent = sendStart()
    await expect(sent.workItemStartOutcome).resolves.toEqual({
      delivered: false,
      deliveryUnknown: true
    })
    expect(mocks.call.mock.calls.map((call) => call[1])).toEqual(['agentSession.history'])
    expect(mocks.uuid).not.toHaveBeenCalled()
  })

  it('finishes a journal rejection once and ignores a late reply', async () => {
    let resolveReply: (value: AgentSessionMutationResult<AgentSessionSendResult>) => void = () => {}
    mocks.call.mockReturnValue(
      new Promise<AgentSessionMutationResult<AgentSessionSendResult>>(
        (resolve) => (resolveReply = resolve)
      )
    )
    const sent = sendStart()
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [submission('rejected')], [])
    const rejected = await sent.workItemStartOutcome
    expect(rejected).toMatchObject({ delivered: false, retryClientMessageId: expect.any(String) })
    expect(rejected.retryClientMessageId).not.toBe(ORIGINAL_ID)
    expect(mocks.uuid).toHaveBeenCalledOnce()
    resolveReply(answerFor('rejected'))
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [submission('rejected')], [])
    expect(mocks.uuid).toHaveBeenCalledOnce()
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it('finishes a reply rejection once and ignores the later journal', async () => {
    mocks.call.mockResolvedValue(answerFor('rejected'))
    const sent = sendStart()
    await expect(sent.workItemStartOutcome).resolves.toMatchObject({
      delivered: false,
      retryClientMessageId: expect.any(String)
    })
    settleStructuredAgentSessionSendsFromJournal(SESSION, [submission('rejected')], [])
    expect(mocks.uuid).toHaveBeenCalledOnce()
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('keeps a timed-out request unknown and never dispatches a retry id', async () => {
    vi.useFakeTimers()
    mocks.call.mockReturnValue(new Promise(() => {}))
    const sent = sendStart()
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
    await expect(sent.workItemStartOutcome).resolves.toEqual({
      delivered: false,
      deliveryUnknown: true
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.uuid).not.toHaveBeenCalled()
  })

  it('settles a dropped strict send without a retry id', async () => {
    mocks.call.mockReturnValue(new Promise(() => {}))
    const sent = sendStart()
    dropStructuredAgentSessionSends(SESSION)
    await expect(sent.outcome).resolves.toBe('dropped')
    await expect(sent.workItemStartOutcome).resolves.toEqual({ delivered: false })
    expect(mocks.uuid).not.toHaveBeenCalled()
  })

  it('preserves the ordinary sender interpretation of a recorded rejection', async () => {
    mocks.call.mockResolvedValue(answerFor('rejected'))
    const sent = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: TEXT })
    await expect(sent?.outcome).resolves.toBe('recorded')
    expect(sent?.workItemStartOutcome).toBeUndefined()
    expect(mocks.uuid).toHaveBeenCalledOnce()
    expect(mocks.handBack).not.toHaveBeenCalled()
  })

  it('keeps identical recovered ids isolated by session', async () => {
    mocks.call.mockReturnValue(new Promise(() => {}))
    noteStructuredAgentSessionFence('other-session', 7)
    const first = sendStart()
    const other = sendStart('other-session')
    await flush()
    settleStructuredAgentSessionSendsFromJournal(SESSION, [], [ORIGINAL_ID])
    await expect(first.workItemStartOutcome).resolves.toEqual({ delivered: true })
    dropStructuredAgentSessionSends('other-session')
    await expect(other.workItemStartOutcome).resolves.toEqual({ delivered: false })
    expect(mocks.uuid).not.toHaveBeenCalled()
  })
})
