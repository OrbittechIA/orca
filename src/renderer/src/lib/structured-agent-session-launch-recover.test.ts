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

import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
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

  it('never reports a lost staged operation as delivered', async () => {
    // The retry finds no outbox entry for the operation it persisted (storage lost): that is
    // unknown, not success and not a reason to stage a second copy.
    const worktreeId = 'wt-recover-lost'
    const intent = launchIntent(worktreeId, 'codex-session-lost')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    mocks.callStructuredAgentSession.mockResolvedValue({ ok: true, page: { fence: 1 } })

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready',
      recover: { intent, clientMessageId: 'message-that-was-lost' }
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      deliveryUnknown: true
    })
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalledWith(
      expect.anything(),
      'agentSession.send',
      expect.anything()
    )
    expect(readOutbox(intent.sessionId)).toEqual([])
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
