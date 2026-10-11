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

import {
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent,
  type restoreStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { getStructuredAgentSessionPendingSends as readOutbox } from '@/components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  structuredAgentLaunchRecordFor
} from './structured-agent-session-launch-persistence'
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

const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'

function persistedLaunchRows(key: string, value: string): unknown[] {
  const rows: unknown = key === LAUNCH_STORAGE_KEY ? JSON.parse(value) : undefined
  return Array.isArray(rows) ? rows : []
}

function retainedMessageId(entropy: 'a' | 'b'): string {
  return `${Date.now()}-${entropy.repeat(32)}`
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
      requestId: 'strict-start',
      prompt: 'https://github.com/salvadorgu7/orca/issues/58',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start'
    })
    await expect(first.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(first.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      deliveryUnknown: true
    })
    expect(readOutbox(intent.sessionId)).toEqual([])
    const M1 = first.recovery.clientMessageId
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toMatchObject(
      { clientMessageId: M1 }
    )
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
      requestId: 'strict-start',
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
    const clientMessageId = retainedMessageId('a')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({ send: () => acceptedSend(clientMessageId, true) })

    const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'strict-start',
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start',
      recover: {
        intent,
        clientMessageId: clientMessageId,
        bodyFingerprint: launchPromptFingerprint(intent.sessionId, 'the prompt')
      }
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 1 })
    await expect(retry.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(sendOperationIds()).toEqual([clientMessageId])
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
      requestId: 'strict-start',
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
    const refusedId = retainedMessageId('a')
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    const accepted = new Set<string>()
    routeSessionCalls({
      send: (operationId) => {
        if (operationId === refusedId) {
          return { ok: false, refusal: { code: 'agent_session_operation_conflict', message: 'no' } }
        }
        const replayed = accepted.has(operationId)
        accepted.add(operationId)
        return acceptedSend(operationId, replayed)
      }
    })
    localStorage.clear()
    const strict = {
      requestId: 'strict-start',
      prompt: 'the prompt',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }

    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      ...strict,
      recover: {
        intent,
        clientMessageId: refusedId,
        bodyFingerprint: launchPromptFingerprint(intent.sessionId, 'the prompt')
      }
    })
    const refused = await first.promptDeliveryResult
    expect(refused).toMatchObject({ delivered: false })
    const retryId = refused?.retryClientMessageId
    expect(retryId).toEqual(expect.any(String))
    await flushLaunchSettlement()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = startStructuredAgentLaunch(worktreeId, 'codex', {
        ...strict,
        recover: {
          intent,
          clientMessageId: retryId ?? null,
          bodyFingerprint: launchPromptFingerprint(intent.sessionId, 'the prompt')
        }
      })
      await expect(retry.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
      await flushLaunchSettlement()
    }

    // One refused attempt, then every retry under the same fresh id: the host ledger accepted
    // exactly one submission and replayed the rest.
    expect(sendOperationIds()).toEqual([refusedId, retryId, retryId])
    expect(accepted).toEqual(new Set([retryId]))
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('delivers a strict prompt once when the refused create is retried', async () => {
    const worktreeId = 'wt-create-refused'
    const strict = {
      requestId: 'strict-start',
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
      requestId: 'strict-start',
      recover: { intent, clientMessageId: null }
    })
    await expect(retry.launchResult).resolves.toEqual({ sessionId: intent.sessionId, fence: 2 })
    // The exact persisted envelope, so the host replays rather than creates.
    expect(mocks.launch).toHaveBeenCalledWith(intent, expect.any(Function))
    expect(mocks.createIntent).not.toHaveBeenCalled()
  })

  it('persists only identity before creating and refuses a changed prompt on recovery', async () => {
    const worktreeId = 'wt-content-free'
    const intent = launchIntent(worktreeId, 'session-content-free')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    mocks.launch.mockImplementation(async () => {
      const record = getPersistedStructuredAgentLaunchRecord(intent.sessionId)
      expect(record?.promptIdentity?.clientMessageId).toEqual(expect.any(String))
      expect(record?.promptIdentity?.bodyFingerprint).toBe(
        launchPromptFingerprint(intent.sessionId, 'original prompt')
      )
      return { sessionId: intent.sessionId, fence: 1 }
    })
    routeSessionCalls({
      send: () => ({
        ok: false,
        refusal: { code: 'agent_session_operation_unknown', message: 'unknown' }
      })
    })
    const first = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'content-free',
      prompt: 'original prompt',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start'
    })
    await first.promptDeliveryResult
    const stored = localStorage.getItem('orca:structuredAgentLaunches:v1')
    expect(stored).not.toContain('original prompt')
    expect(stored).not.toContain(worktreeId)
    const recovery = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'content-free',
      prompt: 'changed prompt',
      promptDelivery: 'submit-after-ready',
      recover: first.recovery
    })
    await expect(recovery.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      deliveryUnknown: true
    })
    expect(sendOperationIds()).toHaveLength(1)
    expect(mocks.launch).toHaveBeenCalledOnce()
  })

  it('refuses create before host mutation when identity persistence fails', async () => {
    const intent = launchIntent('wt-storage-failed')
    mocks.createIntent.mockReturnValueOnce(intent)
    const write = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage full')
    })
    try {
      const launch = startStructuredAgentLaunch(intent.worktreeId, 'codex', {
        requestId: 'storage-failed',
        prompt: 'original prompt',
        promptDelivery: 'submit-after-ready',
        launchOrigin: 'work-item-start'
      })
      await expect(launch.launchResult).rejects.toThrow('Could not save this Start operation')
      await launch.promptDeliveryResult
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(sendOperationIds()).toEqual([])
    } finally {
      write.mockRestore()
    }
  })

  it('restores the durable unknown identity before rejecting another recovery id', async () => {
    const worktreeId = 'wt-reload-mismatched-id'
    const intent = launchIntent(worktreeId)
    const clientMessageId = retainedMessageId('a')
    const bodyFingerprint = launchPromptFingerprint(intent.sessionId, 'original prompt')
    localStorage.setItem(
      LAUNCH_STORAGE_KEY,
      JSON.stringify([
        {
          ...structuredAgentLaunchRecordFor(intent, 'visibility-unknown'),
          promptIdentity: { clientMessageId, bodyFingerprint }
        }
      ])
    )
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({ send: (id) => acceptedSend(id, false) })

    const recovery = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'reload-mismatched-id',
      prompt: 'original prompt',
      promptDelivery: 'submit-after-ready',
      launchOrigin: 'work-item-start',
      recover: { intent, clientMessageId: retainedMessageId('b'), bodyFingerprint }
    })
    await expect(recovery.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      deliveryUnknown: true
    })
    expect(mocks.restoreIntent).toHaveBeenCalledOnce()
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toEqual({
      clientMessageId,
      bodyFingerprint
    })
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('replays the retained send only after explicit recovery following a reload', async () => {
    const worktreeId = 'wt-reload-retained-id'
    const intent = launchIntent(worktreeId)
    const clientMessageId = retainedMessageId('a')
    const bodyFingerprint = launchPromptFingerprint(intent.sessionId, 'original prompt')
    localStorage.setItem(
      LAUNCH_STORAGE_KEY,
      JSON.stringify([
        {
          ...structuredAgentLaunchRecordFor(intent, 'visibility-unknown'),
          promptIdentity: { clientMessageId, bodyFingerprint }
        }
      ])
    )
    expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity).toEqual({
      clientMessageId,
      bodyFingerprint
    })
    await flushLaunchSettlement()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()

    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    routeSessionCalls({ send: (id) => acceptedSend(id, true) })
    const recovery = startStructuredAgentLaunch(worktreeId, 'codex', {
      requestId: 'reload-retained-id',
      prompt: 'original prompt',
      promptDelivery: 'submit-after-ready',
      recover: { intent, clientMessageId, bodyFingerprint }
    })
    await expect(recovery.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.restoreIntent).toHaveBeenCalledOnce()
    expect(sendOperationIds()).toEqual([clientMessageId])
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it.each(['missing-id', 'invalid-id', 'missing-hash', 'invalid-hash'] as const)(
    'keeps the create record but refuses a %s recovery identity without mutation',
    async (fault) => {
      const worktreeId = `wt-incomplete-${fault}`
      const intent = launchIntent(worktreeId)
      const clientMessageId =
        fault === 'missing-id'
          ? null
          : fault === 'invalid-id'
            ? 'invalid-id'
            : retainedMessageId('a')
      const bodyFingerprint =
        fault === 'missing-hash'
          ? undefined
          : fault === 'invalid-hash'
            ? 'invalid-hash'
            : launchPromptFingerprint(intent.sessionId, 'original prompt')
      localStorage.setItem(
        LAUNCH_STORAGE_KEY,
        JSON.stringify([
          {
            ...structuredAgentLaunchRecordFor(intent, 'visibility-unknown'),
            promptIdentity: { clientMessageId, bodyFingerprint }
          }
        ])
      )
      expect(getPersistedStructuredAgentLaunchRecord(intent.sessionId)).toMatchObject({
        sessionId: intent.sessionId,
        clientOperationId: intent.params.envelope.clientOperationId
      })
      routeSessionCalls({ send: (id) => acceptedSend(id, false) })
      const recovery = startStructuredAgentLaunch(worktreeId, 'codex', {
        requestId: `incomplete-${fault}`,
        prompt: 'original prompt',
        promptDelivery: 'submit-after-ready',
        recover: {
          intent,
          clientMessageId,
          ...(bodyFingerprint ? { bodyFingerprint } : {})
        }
      })
      await expect(recovery.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        deliveryUnknown: true
      })
      expect(mocks.createIntent).not.toHaveBeenCalled()
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
    }
  )

  it('rejects promotion of an ordinary recovery intent to Work Item Start', () => {
    const strictIntent = launchIntent('wt-origin-mismatch')
    const { launchOrigin: _origin, ...params } = strictIntent.params
    const intent = { ...strictIntent, params }
    expect(() =>
      startStructuredAgentLaunch(intent.worktreeId, 'codex', {
        requestId: 'origin-mismatch',
        prompt: 'original prompt',
        promptDelivery: 'submit-after-ready',
        launchOrigin: 'work-item-start',
        recover: {
          intent,
          clientMessageId: retainedMessageId('a'),
          bodyFingerprint: launchPromptFingerprint(intent.sessionId, 'original prompt')
        }
      })
    ).toThrow(StructuredAgentSessionCreateRefusalError)
    expect(mocks.restoreIntent).not.toHaveBeenCalled()
    expect(mocks.createIntent).not.toHaveBeenCalled()
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it.each(['changed-prompt', 'missing-identity'] as const)(
    'does not restart a refused create with %s',
    async (fault) => {
      const worktreeId = `wt-refused-${fault}`
      const strict = {
        requestId: `refused-${fault}`,
        prompt: 'original prompt',
        promptDelivery: 'submit-after-ready' as const,
        launchOrigin: 'work-item-start' as const
      }
      mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('refused'))
      const first = startStructuredAgentLaunch(worktreeId, 'codex', strict)
      await expect(first.launchResult).rejects.toThrow('refused')
      await first.promptDeliveryResult
      await flushLaunchSettlement()
      if (fault === 'missing-identity') {
        const state = getStructuredLaunchStateBySessionId(first.sessionId)
        if (!state) {
          throw new Error('Refused launch state was not retained')
        }
        delete state.promptIdentity
      }
      const repeated = startStructuredAgentLaunch(worktreeId, 'codex', {
        ...strict,
        prompt: fault === 'changed-prompt' ? 'changed prompt' : strict.prompt
      })
      await expect(repeated.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        deliveryUnknown: true
      })
      expect(mocks.launch).toHaveBeenCalledOnce()
      expect(mocks.createIntent).toHaveBeenCalledOnce()
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
      expect(readOutbox(first.sessionId)).toEqual([])
    }
  )

  it('retains the old identity when the fresh retry identity cannot be persisted', async () => {
    const worktreeId = 'wt-retry-id-storage-failed'
    const intent = launchIntent(worktreeId)
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    mocks.rendererTabs = {
      [worktreeId]: [{ contentType: 'agent-session', entityId: intent.sessionId, worktreeId }]
    }
    let originalId: string | null = null
    routeSessionCalls({
      send: (id) => {
        originalId = id
        return { ok: false, refusal: { code: 'agent_session_operation_conflict', message: 'no' } }
      }
    })
    const setItem = localStorage.setItem
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (
        originalId &&
        persistedLaunchRows(key, value).some(
          (row) =>
            isUnknownRecord(row) &&
            isUnknownRecord(row.promptIdentity) &&
            row.promptIdentity.clientMessageId !== originalId
        )
      ) {
        throw new Error('storage full')
      }
      setItem(key, value)
    })
    try {
      const first = startStructuredAgentLaunch(worktreeId, 'codex', {
        requestId: 'retry-id-storage-failed',
        prompt: 'original prompt',
        promptDelivery: 'submit-after-ready',
        launchOrigin: 'work-item-start'
      })
      const outcome = await first.promptDeliveryResult
      expect(outcome).toMatchObject({ delivered: false, deliveryUnknown: true })
      expect(outcome?.retryClientMessageId).toBeUndefined()
      await flushLaunchSettlement()
      resetStructuredAgentLaunchPersistenceForTests()
      expect(
        getPersistedStructuredAgentLaunchRecord(intent.sessionId)?.promptIdentity
      ).toMatchObject({
        clientMessageId: originalId
      })
      expect(sendOperationIds()).toEqual([originalId])
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(readOutbox(intent.sessionId)).toEqual([])
    } finally {
      write.mockRestore()
    }
  })

  it('persists the retried create identity before starting a refused create again', async () => {
    const worktreeId = 'wt-restart-storage-failed'
    const strict = {
      requestId: 'restart-storage-failed',
      prompt: 'original prompt',
      promptDelivery: 'submit-after-ready' as const,
      launchOrigin: 'work-item-start' as const
    }
    mocks.launch.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('refused'))
    const first = startStructuredAgentLaunch(worktreeId, 'codex', strict)
    await expect(first.launchResult).rejects.toThrow('refused')
    await first.promptDeliveryResult
    await flushLaunchSettlement()
    const setItem = localStorage.setItem
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (
        persistedLaunchRows(key, value).some(
          (row) => isUnknownRecord(row) && row.clientOperationId === 'operation-retried'
        )
      ) {
        throw new Error('storage full')
      }
      setItem(key, value)
    })
    try {
      const retry = startStructuredAgentLaunch(worktreeId, 'codex', strict)
      await expect(retry.launchResult).rejects.toThrow('Could not save this Start operation')
      await retry.promptDeliveryResult
      expect(mocks.retryIntent).toHaveBeenCalledOnce()
      expect(mocks.launch).toHaveBeenCalledOnce()
      expect(mocks.createIntent).toHaveBeenCalledOnce()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
      expect(readOutbox(first.sessionId)).toEqual([])
    } finally {
      write.mockRestore()
    }
  })
})
