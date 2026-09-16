import { beforeEach, describe, expect, it, vi } from 'vitest'

type PendingCreationState = { pendingWorktreeCreations: Record<string, unknown> }
type PendingCreationListener = (state: PendingCreationState) => void
type BeginArgs = {
  beforeOpen?: (sessionId: string) => boolean | void
  hooks?: { signal?: AbortSignal }
}
type ProvisionalLaunch = {
  sessionId: string
  tab: { id: string }
  settlement?: Promise<unknown>
}
const mocks = vi.hoisted(() => {
  let listener: PendingCreationListener | null = null
  return {
    state: {
      pendingWorktreeCreations: Object.fromEntries([['creation-1', {}]]),
      updatePendingWorktreeCreation: vi.fn<(id: string, patch: unknown) => void>()
    },
    get listener() {
      return listener
    },
    set listener(value: PendingCreationListener | null) {
      listener = value
    },
    unsubscribe: vi.fn<() => void>(),
    beginStructuredAgentSessionProvisionalLaunch:
      vi.fn<(args: BeginArgs) => ProvisionalLaunch | null>(),
    activateAndRevealWorktree: vi.fn<(worktreeId: string, options?: unknown) => unknown>()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn<() => unknown>(), {
    getState: () => mocks.state,
    subscribe: vi.fn<(listener: PendingCreationListener) => () => void>(
      (listener: PendingCreationListener) => {
        mocks.listener = listener
        return mocks.unsubscribe
      }
    )
  })
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

const request = {
  repoId: 'repo-1',
  name: 'routing-recovery',
  setupDecision: 'run' as const,
  agent: 'codex' as const,
  agentLaunchRoute: 'structured-native-chat' as const,
  pendingFirstAgentMessageRename: true,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the route',
  quickTelemetry: null
}

const baseArgs = {
  creationId: 'creation-1',
  request,
  agentLaunchRoute: 'structured-native-chat' as const,
  worktreeId: 'worktree-1',
  shouldActivateOnCompletion: true,
  activation: false as const,
  primaryTabId: null
}

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.pendingWorktreeCreations = Object.fromEntries([['creation-1', {}]])
    mocks.listener = null
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })
  })

  it('reveals the created workspace before opening its final-id chat tab', async () => {
    const order: string[] = []
    mocks.activateAndRevealWorktree.mockImplementation(() => {
      order.push('reveal')
      return { primaryTabId: null }
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      order.push('begin')
      args.beforeOpen?.('session-1')
      order.push('open')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toEqual({
      accepted: true,
      cancelled: false,
      activation: { primaryTabId: null },
      primaryTabId: 'agent-session:session-1'
    })
    expect(order).toEqual(['begin', 'reveal', 'open'])
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { worktreeId: 'worktree-1' },
        activate: true,
        plan: expect.objectContaining({
          route: 'structured-native-chat',
          agent: 'codex',
          prompt: 'Fix the route'
        })
      })
    )
  })

  it('does not launch after the pending creation was cancelled', async () => {
    mocks.state.pendingWorktreeCreations = {}

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      cancelled: true,
      primaryTabId: null
    })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
  })

  it('keeps deferred activation from selecting the provisional tab', async () => {
    await expect(
      launchStructuredWorktreeSession({
        ...baseArgs,
        shouldActivateOnCompletion: false,
        primaryTabId: 'existing-tab'
      })
    ).resolves.toMatchObject({ primaryTabId: 'agent-session:session-1' })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ activate: false })
    )
  })

  it('does not open a tab when cancellation races the reveal callback', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      const pending = mocks.state.pendingWorktreeCreations
      mocks.state.pendingWorktreeCreations = {}
      mocks.listener?.(mocks.state)
      mocks.state.pendingWorktreeCreations = pending
      const allowed = args.beforeOpen?.('session-1')
      return allowed === false
        ? null
        : { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      cancelled: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})

const RECOVERY = {
  intent: {
    sessionId: 'session-1',
    worktreeId: 'worktree-1',
    agent: 'codex' as const,
    target: { kind: 'local' as const },
    params: {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'create-op-1',
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'.repeat(64)
      },
      worktree: 'id:worktree-1',
      agent: 'codex' as const,
      launchOrigin: 'work-item-start' as const
    }
  },
  clientMessageId: 'message-op-1'
}

const strictArgs = {
  ...baseArgs,
  request: { ...request, workItemStartPromptDelivery: 'submit-after-ready' as const }
}

function settlesAs(settlement: unknown): void {
  mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
    args.beforeOpen?.('session-1')
    return {
      sessionId: 'session-1',
      tab: { id: 'agent-session:session-1' },
      settlement: Promise.resolve(settlement)
    }
  })
}

describe('launchStructuredWorktreeSession under a strict Work Item Start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.pendingWorktreeCreations = Object.fromEntries([['creation-1', {}]])
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
  })

  it('re-enters with the scoped origin and the persisted recovery, and completes on proof', async () => {
    settlesAs({
      kind: 'structured',
      sessionId: 'session-1',
      recovery: RECOVERY,
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })

    await expect(
      launchStructuredWorktreeSession({ ...strictArgs, recover: RECOVERY })
    ).resolves.toMatchObject({ accepted: true, cancelled: false, recovery: RECOVERY })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ launchOrigin: 'work-item-start', recover: RECOVERY })
      })
    )
  })

  it('keeps an unknown launch outcome reconcilable under its recovery', async () => {
    settlesAs({ kind: 'visibility-unknown', sessionId: 'session-1', recovery: RECOVERY })

    await expect(launchStructuredWorktreeSession(strictArgs)).resolves.toMatchObject({
      visibilityUnknown: true,
      recovery: RECOVERY
    })
  })

  it('reports a refused strict create without accepting it', async () => {
    settlesAs({ kind: 'failed', error: new StructuredAgentSessionCreateRefusalError('refused') })

    await expect(launchStructuredWorktreeSession(strictArgs)).resolves.toMatchObject({
      accepted: false,
      failure: 'structured-refused'
    })
  })

  it('treats an unconfirmed prompt as unknown and a refused one as a definitive failure', async () => {
    settlesAs({
      kind: 'structured',
      sessionId: 'session-1',
      recovery: RECOVERY,
      promptDeliveryResult: Promise.resolve({
        delivered: false,
        failureNotified: false,
        deliveryUnknown: true
      })
    })
    await expect(launchStructuredWorktreeSession(strictArgs)).resolves.toMatchObject({
      promptDeliveryUnknown: true,
      recovery: RECOVERY
    })

    settlesAs({
      kind: 'structured',
      sessionId: 'session-1',
      recovery: RECOVERY,
      promptDeliveryResult: Promise.resolve({ delivered: false, failureNotified: false })
    })
    await expect(launchStructuredWorktreeSession(strictArgs)).resolves.toMatchObject({
      failure: 'prompt-delivery'
    })
  })
})
