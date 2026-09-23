// @vitest-environment happy-dom

import { isUnknownRecord } from '../../../shared/unknown-record'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Strict quick-create Start from the request the composer builds down to the outbox the launch
// leaves behind. Only the host (create + send RPCs) and the store are faked; the plan, the launch
// registry, the settle loop and the outbox are real.

type RendererTab = { contentType: string; entityId: string; worktreeId: string }

function noRendererTabs(): Record<string, RendererTab[]> {
  return {}
}

function onePendingCreation(): Record<string, unknown> {
  return { 'creation-1': {} }
}

const mocks = vi.hoisted(() => ({
  callStructuredAgentSession: vi.fn(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  abandonIntent: vi.fn(),
  launch: vi.fn(),
  rendererTabs: noRendererTabs(),
  pending: onePendingCreation()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

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

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () =>
    Object.entries(mocks.rendererTabs).map(([worktree, tabs]) => ({
      worktree,
      tabs: tabs.map((tab) => ({ type: 'agent-session', sessionId: tab.entityId }))
    }))
  )
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => ({
      pendingWorktreeCreations: mocks.pending,
      allWorktrees: () => [{ id: 'worktree-1', path: '/tmp/worktree-1' }],
      repos: [{ id: 'repo-1', connectionId: null }],
      unifiedTabsByWorktree: mocks.rendererTabs,
      createUnifiedTab: vi.fn((_worktreeId: string, _type: string, tab: { id: string }) => tab),
      setActiveTabType: vi.fn(),
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: vi.fn(() => () => {})
  })
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

import { readOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

const PROMPT = 'https://github.com/salvadorgu7/orca/issues/58'
const SESSION = 'codex-session-worktree-1'

/** The request quick-create builds for a strict Start. `auto-submit` is the stale value the old
 *  call site sent; the launch boundary must still deliver it strictly. */
function strictRequest(promptDelivery: 'submit-after-ready' | 'auto-submit') {
  return {
    repoId: 'repo-1',
    name: 'issue-58',
    setupDecision: 'skip' as const,
    agent: 'codex' as const,
    agentLaunchRoute: 'structured-native-chat' as const,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: PROMPT,
    quickTelemetry: null,
    promptDelivery,
    workItemStartPromptDelivery: 'submit-after-ready' as const
  }
}

function sendOperationIds(): unknown[] {
  return mocks.callStructuredAgentSession.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) => {
      const envelope = isUnknownRecord(call[2]) ? call[2].envelope : undefined
      return isUnknownRecord(envelope) ? envelope.clientOperationId : undefined
    })
}

function sentTexts(): unknown[] {
  return mocks.callStructuredAgentSession.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) => {
      const body = isUnknownRecord(call[2]) && isUnknownRecord(call[2].body) ? call[2].body : {}
      const [block] = Array.isArray(body.blocks) ? body.blocks : []
      return isUnknownRecord(block) ? block.text : undefined
    })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('strict quick-create Start delivery at the outbox boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.pending = onePendingCreation()
    mocks.rendererTabs = {
      'worktree-1': [{ contentType: 'agent-session', entityId: SESSION, worktreeId: 'worktree-1' }]
    }
    mocks.createIntent.mockImplementation((worktreeId: string, agent: 'codex') => ({
      worktreeId,
      sessionId: SESSION,
      agent,
      target: { kind: 'local' },
      params: {
        envelope: {
          sessionId: SESSION,
          clientOperationId: 'create-op-1',
          expectedRuntimeFence: null,
          payloadFingerprint: 'f'.repeat(64)
        },
        worktree: `id:${worktreeId}`,
        agent,
        launchOrigin: 'work-item-start'
      }
    }))
    mocks.launch.mockResolvedValue({ sessionId: SESSION, fence: 1 })
  })

  it.each(['submit-after-ready', 'auto-submit'] as const)(
    'leaves the outbox empty on a settled refusal, and the retry delivers the same prompt once (%s request)',
    async (promptDelivery) => {
      const accepted = new Set<string>()
      let refuseNext = true
      mocks.callStructuredAgentSession.mockImplementation(
        async (_target: unknown, method: string, params: unknown) => {
          if (method !== 'agentSession.send') {
            return { ok: true, page: { fence: 1 } }
          }
          if (refuseNext) {
            refuseNext = false
            return {
              ok: false,
              refusal: { code: 'agent_session_operation_conflict', message: 'no' }
            }
          }
          const envelope = isUnknownRecord(params) ? params.envelope : undefined
          const id =
            isUnknownRecord(envelope) && typeof envelope.clientOperationId === 'string'
              ? envelope.clientOperationId
              : ''
          const replayed = accepted.has(id)
          accepted.add(id)
          return {
            ok: true,
            replayed,
            fence: 1,
            cursor: { epoch: 'epoch-a', sequence: 1 },
            value: {
              clientMessageId: id,
              submission: { clientMessageId: id, dispatchState: 'accepted' }
            }
          }
        }
      )
      const request = strictRequest(promptDelivery)
      const launchArgs = {
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat' as const,
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: false,
        activation: false as const,
        primaryTabId: null
      }

      const refused = await launchStructuredWorktreeSession(launchArgs)
      await flush()

      expect(refused).toMatchObject({ failure: 'prompt-delivery', promptRetryable: true })
      // Nothing queued for the mounted legacy outbox to send behind the Start.
      expect(readOutbox(SESSION)).toEqual([])
      const firstId = sendOperationIds()[0]
      const retryId = refused.recovery?.clientMessageId
      expect(retryId).toEqual(expect.any(String))
      expect(retryId).not.toBe(firstId)
      expect(refused.recovery?.intent.sessionId).toBe(SESSION)

      // Retry exactly as the pending creation does: same immutable request, persisted recovery.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const retried = await launchStructuredWorktreeSession({
          ...launchArgs,
          recover: refused.recovery
        })
        await flush()
        expect(retried.accepted).toBe(true)
        expect(retried.failure).toBeUndefined()
      }

      // One refused attempt, then every retry under the same id and text: one writer, one session.
      expect(sendOperationIds()).toEqual([firstId, retryId, retryId])
      expect(sentTexts()).toEqual([PROMPT, PROMPT, PROMPT])
      expect(accepted).toEqual(new Set([retryId]))
      expect(mocks.createIntent).toHaveBeenCalledTimes(1)
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(readOutbox(SESSION)).toEqual([])
    }
  )
})
