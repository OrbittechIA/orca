// @vitest-environment happy-dom

import { isUnknownRecord } from '../../../shared/unknown-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RecoveryModule from '@/lib/structured-agent-session-launch-recovery'

type RendererTab = { contentType: string; entityId: string; worktreeId: string }

function noRendererTabs(): Record<string, RendererTab[]> {
  return {}
}

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn(),
  rendererTabs: noRendererTabs(),
  listeners: new Set<(state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void>()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
})

// Publication is read from the host's authoritative tab snapshot, projected here from the tabs a
// test publishes.
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () =>
    Object.entries(mocks.rendererTabs).map(([worktree, tabs]) => ({
      worktree,
      tabs: tabs.map((tab) => ({
        type: 'agent-session',
        sessionId: tab.entityId
      }))
    }))
  )
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: mocks.rendererTabs,
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    }),
    subscribe: (
      listener: (state: { unifiedTabsByWorktree: Record<string, unknown[]> }) => void
    ) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude'),
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}))

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    agent: 'codex',
    target: { kind: 'local' },
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

type SessionRoute = { send: (operationId: string) => unknown }

/** Answers each structured RPC by method: the session is published, sends go to `route.send`. */
function routeSessionCalls(route: SessionRoute): void {
  mocks.callStructuredAgentSession.mockImplementation(
    async (_target: unknown, method: string, params: unknown) => {
      if (method !== 'agentSession.send') {
        return { ok: true, page: { fence: 1 } }
      }
      const envelope = isUnknownRecord(params) ? params.envelope : undefined
      const operationId =
        isUnknownRecord(envelope) && typeof envelope.clientOperationId === 'string'
          ? envelope.clientOperationId
          : ''
      return route.send(operationId)
    }
  )
}

function acceptedSend(clientMessageId: string, replayed: boolean) {
  return {
    ok: true,
    replayed,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 1 },
    value: { clientMessageId, submission: { clientMessageId, dispatchState: 'accepted' } }
  }
}

function sendCalls(): Record<string, unknown>[] {
  return mocks.callStructuredAgentSession.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) => (isUnknownRecord(call[2]) ? call[2] : {}))
}

function sendOperationIds(): unknown[] {
  return sendCalls().map((params) =>
    isUnknownRecord(params.envelope) ? params.envelope.clientOperationId : undefined
  )
}

function sentTexts(): unknown[] {
  return sendCalls().map((params) => {
    const body = isUnknownRecord(params.body) ? params.body : {}
    const [block] = Array.isArray(body.blocks) ? body.blocks : []
    return isUnknownRecord(block) ? block.text : undefined
  })
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('startStructuredAgentLaunch recovery re-entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.rendererTabs = {}
    mocks.listeners.clear()
    mocks.createIntent.mockImplementation((worktreeId: string, agent: 'claude' | 'codex') => {
      const intent = launchIntent(worktreeId, `${agent}-session-${worktreeId}`)
      return { ...intent, agent, params: { ...intent.params, agent } }
    })
    // A retried create keeps its session id and mints only a new create operation.
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: { ...intent.params.envelope, clientOperationId: 'operation-retried' }
      }
    }))
  })

  it('replays the same session and the same prompt operation after an unknown delivery', async () => {
    // S1/M1: the create lands, the prompt's outcome is unknown, the pending state is released.
    // The retry must re-enter with S1 and M1 — never S2, never M2 — and the host sees one
    // create and one send envelope replayed, i.e. one executor.
    const worktreeId = 'wt-recover'
    const intent = launchIntent(worktreeId, 'codex-session-S1')
    mocks.createIntent.mockReturnValueOnce({
      ...intent,
      params: { ...intent.params, launchOrigin: 'work-item-start' }
    })
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    mocks.callStructuredAgentSession.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.send'
        ? {
            ok: false,
            refusal: { code: 'agent_session_operation_unknown', message: 'ledger unknown' }
          }
        : { ok: true, page: { fence: 1 } }
    )

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'https://github.com/salvadorgu7/orca/issues/58',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start'
    })
    await expect(first.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(first.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      deliveryUnknown: true
    })
    const staged = readOutbox(intent.sessionId)
    expect(staged).toHaveLength(1)
    const M1 = staged[0]!.clientMessageId
    expect(first.recovery).toEqual({ intent: first.recovery.intent, clientMessageId: M1 })
    expect(first.recovery.intent.sessionId).toBe(intent.sessionId)
    await flushLaunchSettlement()
    const firstSend = mocks.callStructuredAgentSession.mock.calls.find(
      (call) => call[1] === 'agentSession.send'
    )
    expect(firstSend?.[2]).toMatchObject({
      envelope: { sessionId: intent.sessionId, clientOperationId: M1 }
    })

    // Retry, as the pending creation would: same prompt, the persisted recovery.
    mocks.callStructuredAgentSession.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.send'
        ? { ok: true, value: { submission: { dispatchState: 'accepted' } } }
        : { ok: true, page: { fence: 1 } }
    )
    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'https://github.com/salvadorgu7/orca/issues/58',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start',
      recover: first.recovery
    })
    expect(retry.sessionId).toBe(intent.sessionId)
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })

    // No second intent was minted and the session was found, not re-created.
    expect(mocks.createIntent).toHaveBeenCalledTimes(1)
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    const sends = mocks.callStructuredAgentSession.mock.calls.filter(
      (call) => call[1] === 'agentSession.send'
    )
    expect(sends).toHaveLength(2)
    expect(sends.map((call) => (isUnknownRecord(call[2]) ? call[2].envelope : undefined))).toEqual([
      expect.objectContaining({ sessionId: intent.sessionId, clientOperationId: M1 }),
      expect.objectContaining({ sessionId: intent.sessionId, clientOperationId: M1 })
    ])
    expect(readOutbox(intent.sessionId)).toEqual([])
  })

  it('restages a lost staged operation under its SAME id and delivers it once', async () => {
    // The retry finds no outbox entry for the operation it persisted (storage lost, or the mounted
    // outbox drained it). Restaging under the same id lets the host ledger replay an accepted send
    // instead of delivering a second copy, and a never-admitted one is delivered once.
    const worktreeId = 'wt-recover-lost'
    const intent = launchIntent(worktreeId, 'codex-session-lost')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({ send: () => acceptedSend('message-that-was-lost', true) })

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start',
      recover: { intent, clientMessageId: 'message-that-was-lost' }
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(sendOperationIds()).toEqual(['message-that-was-lost'])
    expect(sentTexts()).toEqual(['the prompt'])
    expect(readOutbox(intent.sessionId)).toEqual([])
  })

  it('still reports unknown when a legacy recovery kept no operation id', async () => {
    const worktreeId = 'wt-recover-legacy'
    const intent = launchIntent(worktreeId, 'codex-session-legacy')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({ send: () => acceptedSend('unused', false) })

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready',
      recover: { intent, clientMessageId: null }
    })
    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      deliveryUnknown: true
    })
    expect(sendOperationIds()).toEqual([])
  })

  it('retries a strict refusal once under one fresh id, and repeats idempotently', async () => {
    const worktreeId = 'wt-recover-refused'
    const intent = launchIntent(worktreeId, 'codex-session-refused')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    const accepted = new Set<string>()
    routeSessionCalls({
      send: (operationId) => {
        if (operationId === 'message-refused') {
          return { ok: false, refusal: { code: 'agent_session_operation_conflict', message: 'no' } }
        }
        const replayed = accepted.has(operationId)
        accepted.add(operationId)
        return acceptedSend(operationId, replayed)
      }
    })
    localStorage.clear()
    const strict = {
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      ...strict,
      recover: { intent, clientMessageId: 'message-refused' }
    })
    const refused = await first.promptDeliveryResult
    expect(refused).toMatchObject({ delivered: false })
    const retryId = refused?.retryClientMessageId
    expect(retryId).toEqual(expect.any(String))
    await flushLaunchSettlement()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
        ...strict,
        recover: { intent, clientMessageId: retryId ?? null }
      })
      await expect(retry.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
      await flushLaunchSettlement()
    }

    // One refused attempt, then every retry under the same fresh id: the host ledger accepted
    // exactly one submission and replayed the rest.
    expect(sendOperationIds()).toEqual(['message-refused', retryId, retryId])
    expect(accepted).toEqual(new Set([retryId]))
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('delivers a strict prompt once when the refused create is retried', async () => {
    const worktreeId = 'wt-create-refused'
    const strict = {
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }
    mocks.createIntent.mockImplementation((id: string, agent: 'claude' | 'codex') => {
      const intent = launchIntent(id, `${agent}-session-${id}`)
      return {
        ...intent,
        agent,
        params: { ...intent.params, agent, launchOrigin: 'work-item-start' }
      }
    })
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
      .mockImplementationOnce(async (given: StructuredAgentSessionLaunchIntent) => {
        mocks.rendererTabs = {
          [worktreeId]: [{ contentType: 'agent-session', entityId: given.sessionId, worktreeId }]
        }
        return { sessionId: given.sessionId, fence: 1 }
      })
    routeSessionCalls({ send: (operationId) => acceptedSend(operationId, false) })

    const first = startStructuredAgentLaunch(worktreeId, 'codex', strict)
    await expect(first.launchResult).rejects.toThrow('refused')
    await flushLaunchSettlement()

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', strict)
    expect(retry.sessionId).toBe(first.sessionId)
    await expect(retry.promptDeliveryResult).resolves.toMatchObject({ delivered: true })

    // The staged prompt never went out on the refused attempt; the retry sends that same entry once.
    expect(sendOperationIds()).toEqual([first.recovery.clientMessageId])
    expect(sentTexts()).toEqual(['the prompt'])
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.createIntent).toHaveBeenCalledTimes(1)
  })

  it('replays the persisted create when the session is not published yet', async () => {
    const worktreeId = 'wt-recover-replay'
    const intent = launchIntent(worktreeId, 'codex-session-replay')
    mocks.callStructuredAgentSession.mockRejectedValue(new Error('no history'))
    mocks.launch.mockImplementation(async (given: StructuredAgentSessionLaunchIntent) => {
      mocks.rendererTabs = {
        [worktreeId]: [{ contentType: 'agent-session', entityId: given.sessionId, worktreeId }]
      }
      return { sessionId: given.sessionId, fence: 2 }
    })

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      recover: { intent, clientMessageId: null }
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 2 })
    // The exact persisted envelope, so the host replays rather than creates.
    expect(mocks.launch).toHaveBeenCalledWith(intent)
    expect(mocks.createIntent).not.toHaveBeenCalled()
  })
})
