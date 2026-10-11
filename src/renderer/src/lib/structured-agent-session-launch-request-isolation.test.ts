// @vitest-environment happy-dom

import { isUnknownRecord } from '../../../shared/unknown-record'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  restoreIntent: vi.fn(),
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
  class StructuredAgentSessionOwnerUnresolvedError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionOwnerUnresolvedError
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

import type {
  StructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getPersistedStructuredAgentLaunchRecord
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { launchPromptFingerprint } from './structured-agent-session-launch-staging'

function launchIntent(
  worktreeId: string,
  sessionId = `session-${worktreeId}`
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    executionHostId: 'local',
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
      agent: 'codex',
      launchOrigin: 'work-item-start'
    }
  }
}

type RestoreIntentArgs = Parameters<typeof restoreStructuredAgentSessionLaunchIntent>[0]

function restoreIntent(args: RestoreIntentArgs): StructuredAgentSessionLaunchIntent {
  const intent = launchIntent(args.worktreeId, args.sessionId)
  intent.executionHostId = args.executionHostId
  intent.agent = args.agent
  intent.params.agent = args.agent
  intent.params.envelope = {
    sessionId: args.sessionId,
    clientOperationId: args.clientOperationId,
    expectedRuntimeFence: args.expectedRuntimeFence,
    payloadFingerprint: args.payloadFingerprint
  }
  delete intent.params.launchOrigin
  if (args.launchOrigin) {
    intent.params.launchOrigin = args.launchOrigin
  }
  return intent
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

describe('strict Start request isolation', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    resetStructuredAgentSessionSendsForTests()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    vi.clearAllMocks()
    mocks.launch.mockReset()
    mocks.callStructuredAgentSession.mockReset()
    vi.stubGlobal('localStorage', new Storage())
    mocks.rendererTabs = {}
    mocks.listeners.clear()
    mocks.restoreIntent.mockImplementation(restoreIntent)
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

  it('keeps a blank Start separate from another request and its double click', async () => {
    const worktreeId = 'blank-strict-isolation'
    mocks.createIntent
      .mockReturnValueOnce(launchIntent(worktreeId, 'blank-session'))
      .mockReturnValueOnce(launchIntent(worktreeId, 'text-session'))
    mocks.launch.mockImplementation(() => new Promise(() => {}))
    const blank = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'blank-action',
      launchOrigin: 'work-item-start'
    })
    const options = {
      requestId: 'text-action',
      prompt: 'the work item',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }
    const first = startStructuredAgentLaunch(worktreeId, 'codex', options)
    const duplicate = startStructuredAgentLaunch(worktreeId, 'codex', options)
    expect(first.sessionId).not.toBe(blank.sessionId)
    expect(duplicate.sessionId).toBe(first.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledTimes(2)
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(sendOperationIds()).toEqual([])
  })

  it('does not restore a historical refusal id before or after a duplicate settles', async () => {
    const worktreeId = 'historical-refusal-isolation'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({
      send: () => ({
        ok: false,
        refusal: { code: 'agent_session_operation_conflict', message: 'refused' }
      })
    })
    const options = {
      requestId: 'original-action',
      prompt: 'the work item',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }
    const first = startStructuredAgentLaunch(worktreeId, 'codex', options)
    const refused = await first.promptDeliveryResult
    await flushLaunchSettlement()
    const retryId = refused?.retryClientMessageId
    expect(retryId).toEqual(expect.any(String))
    const duplicate = startStructuredAgentLaunch(worktreeId, 'codex', options)
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toMatchObject(
      { clientMessageId: retryId }
    )
    await duplicate.promptDeliveryResult
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toMatchObject(
      { clientMessageId: retryId }
    )
    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      ...options,
      recover: {
        intent,
        clientMessageId: retryId ?? null,
        bodyFingerprint: launchPromptFingerprint(intent.sessionId, options.prompt)
      }
    })
    const retryRefused = await retry.promptDeliveryResult
    await flushLaunchSettlement()
    const currentId = retryRefused?.retryClientMessageId
    expect(currentId).toEqual(expect.any(String))
    expect(currentId).not.toBe(retryId)
    const stale = startStructuredAgentLaunch(worktreeId, 'codex', options)
    await expect(stale.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      deliveryUnknown: true
    })
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toMatchObject(
      { clientMessageId: currentId }
    )
    expect(sendOperationIds()).toHaveLength(2)
    expect(sentTexts()).toEqual(['the work item', 'the work item'])
  })
})
