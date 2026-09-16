import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    pendingWorktreeCreations: { 'creation-1': {} } as Record<string, unknown>
  },
  listener: null as ((state: { pendingWorktreeCreations: Record<string, unknown> }) => void) | null,
  unsubscribe: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  cancelStructuredAgentLaunch: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn(),
  ensureWebRuntimeWorktreeTerminalAfterWake: vi.fn(),
  preflightAgentTrust: vi.fn(),
  updateWorktreeMeta: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => mocks.state,
    subscribe: vi.fn(
      (listener: (state: { pendingWorktreeCreations: Record<string, unknown> }) => void) => {
        mocks.listener = listener
        return mocks.unsubscribe
      }
    )
  })
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch,
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => ({ id: worktreeId })
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))

vi.mock('@/lib/web-runtime-worktree-terminal-after-wake', () => ({
  ensureWebRuntimeWorktreeTerminalAfterWake: mocks.ensureWebRuntimeWorktreeTerminalAfterWake
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: mocks.preflightAgentTrust
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

const idle = { accepted: true, cancelled: false, visibilityUnknown: false }

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

/** Mirrors the callers layer: a refusal runs the claimed fallback once and resolves true. */
function refusedLaunch(sessionId = 'session-refused') {
  const launchResult = Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
  mocks.startStructuredAgentLaunch.mockReturnValue({
    sessionId,
    launchResult,
    isVisibilityUnknown: () => false,
    releaseCallerAfterUnknownOutcome: vi.fn(),
    claimDefinitiveRefusalFallback: vi.fn((fallback: () => Promise<void>) =>
      launchResult.catch(() =>
        Promise.resolve()
          .then(fallback)
          .then(() => true)
      )
    )
  })
}

function storeWithWorktree() {
  mocks.state = {
    pendingWorktreeCreations: { 'creation-1': {} },
    allWorktrees: () => [{ id: 'worktree-1', path: '/tmp/worktree-1' }],
    repos: [{ id: 'repo-1', connectionId: 'ssh-1' }],
    updateWorktreeMeta: mocks.updateWorktreeMeta
  } as unknown as typeof mocks.state
}

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { pendingWorktreeCreations: { 'creation-1': {} } }
    mocks.listener = null
    mocks.closeStructuredAgentSession.mockResolvedValue('closed')
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
    mocks.updateWorktreeMeta.mockResolvedValue(undefined)
    mocks.preflightAgentTrust.mockResolvedValue(undefined)
  })

  it('activates the structured session once it is published', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({ ...idle, activation: { primaryTabId: null }, primaryTabId: null })
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'Fix the route'
    })
    expect(mocks.activateStructuredAgentSessionById).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('hands the loop the delivery mode the composer decided with the route', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: { ...request, launchDraftPrompt: 'PR #1 context', promptDelivery: 'draft' },
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'PR #1 context',
      promptDelivery: 'draft'
    })
  })

  it('does not activate a published session when the user has moved on', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: false,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: 'tab-existing'
    })
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
  })

  it('retries an unknown launch with its persisted intent and staged operation, never a new one', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      recovery: RECOVERY,
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    const result = await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null,
      recover: RECOVERY
    })
    // The prompt travels with the retry so its delivery is settled, and the launch layer looks
    // the staged operation up by `recover` instead of staging a second copy.
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
      prompt: 'Fix the route',
      recover: RECOVERY
    })
    expect(result.recovery).toEqual(RECOVERY)
  })

  it('hands every launch its recovery intent so an unknown outcome can be re-entered', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      recovery: RECOVERY,
      launchResult: Promise.reject(new Error('lost reply')),
      isVisibilityUnknown: () => true,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    const result = await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })
    expect(result).toMatchObject({ visibilityUnknown: true, recovery: RECOVERY })
  })

  describe('strict Work Item Start (submit-after-ready)', () => {
    const strictRequest = { ...request, workItemStartPromptDelivery: 'submit-after-ready' as const }

    it('keeps the scoped launch origin the preflight was admitted under', async () => {
      mocks.startStructuredAgentLaunch.mockReturnValue({
        sessionId: 'session-1',
        recovery: RECOVERY,
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false }),
        isVisibilityUnknown: () => false,
        releaseCallerAfterUnknownOutcome: vi.fn(),
        claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
      })
      await launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: { ...strictRequest, promptDelivery: 'auto-submit' },
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
      expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'codex', {
        prompt: 'Fix the route',
        promptDelivery: 'auto-submit',
        launchOrigin: 'work-item-start'
      })
    })

    it('opens no legacy terminal after a definitive refusal: fail closed, retry allowed', async () => {
      // Counterexample the review gave: the strict preflight admitted the scoped capability while
      // global structured chat is off; a generic create is refused; a declared fallback then
      // started the terminal writer strict mode forbids.
      storeWithWorktree()
      refusedLaunch()
      mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'terminal-tab' })

      const result = await launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: strictRequest,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: { paste: 'x' } as never,
        activation: false,
        primaryTabId: null
      })

      expect(result).toMatchObject({
        accepted: false,
        cancelled: false,
        failure: 'structured-refused',
        activation: false,
        primaryTabId: null
      })
      // No fallback was even offered to the launch layer, so no path can reach a terminal.
      const launch = mocks.startStructuredAgentLaunch.mock.results[0]?.value as {
        claimDefinitiveRefusalFallback: ReturnType<typeof vi.fn>
      }
      expect(launch.claimDefinitiveRefusalFallback).not.toHaveBeenCalled()
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
      expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
      expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).not.toHaveBeenCalled()
      expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
      expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
    })

    it('reports an unconfirmed delivery with the intent and operation a retry must reuse', async () => {
      mocks.startStructuredAgentLaunch.mockReturnValue({
        sessionId: 'session-1',
        recovery: RECOVERY,
        launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
        promptDeliveryResult: Promise.resolve({
          delivered: false,
          failureNotified: false,
          deliveryUnknown: true
        }),
        isVisibilityUnknown: () => false,
        releaseCallerAfterUnknownOutcome: vi.fn(),
        claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
      })
      const result = await launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: strictRequest,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: false,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
      expect(result).toMatchObject({ promptDeliveryUnknown: true, recovery: RECOVERY })
    })
  })

  it('returns cancelled without starting a launch when the creation is already gone', async () => {
    mocks.state = { pendingWorktreeCreations: {} }

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({ ...idle, cancelled: true, activation: false, primaryTabId: null })
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('discards the launch eagerly when the creation is dismissed while it is pending', async () => {
    const launchResult = new Promise<never>(() => {})
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult,
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => launchResult)
    })

    void launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })
    await Promise.resolve()
    expect(mocks.cancelStructuredAgentLaunch).not.toHaveBeenCalled()

    mocks.state = { pendingWorktreeCreations: {} }
    mocks.listener?.(mocks.state)
    mocks.listener?.(mocks.state)
    expect(mocks.cancelStructuredAgentLaunch).toHaveBeenCalledExactlyOnceWith(
      'worktree-1',
      'session-1'
    )
  })

  it('falls back to an activated terminal after a definitive refusal', async () => {
    storeWithWorktree()
    refusedLaunch()
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'terminal-tab' })
    const startup = { kind: 'agent', agent: 'codex', prompt: 'Fix the route' }

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: startup as never,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      ...idle,
      accepted: false,
      activation: { primaryTabId: 'terminal-tab' },
      primaryTabId: 'terminal-tab'
    })
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('worktree-1', {
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.preflightAgentTrust).toHaveBeenCalledWith({
      agent: 'codex',
      workspacePath: '/tmp/worktree-1',
      connectionId: 'ssh-1'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      sidebarRevealBehavior: 'auto',
      createNewTerminalForStartup: true,
      startup
    })
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('seeds a background terminal after a refusal when the user has moved on', async () => {
    storeWithWorktree()
    refusedLaunch()
    mocks.ensureWorktreeHasInitialTerminal.mockReturnValue('background-tab')

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: false,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      ...idle,
      accepted: false,
      activation: false,
      primaryTabId: 'background-tab'
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).toHaveBeenCalledWith(
      mocks.state,
      'worktree-1',
      undefined,
      undefined,
      undefined,
      undefined,
      { activateCreatedTabs: false, createNewTerminalForStartup: true }
    )
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).toHaveBeenCalledWith('worktree-1', {
      startup: undefined,
      agent: 'codex',
      activate: false
    })
  })

  it('stops the fallback mid-way when the creation is dismissed and retires nothing', async () => {
    storeWithWorktree()
    refusedLaunch()
    mocks.preflightAgentTrust.mockImplementation(async () => {
      mocks.state = { ...mocks.state, pendingWorktreeCreations: {} }
      mocks.listener?.(mocks.state)
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      ...idle,
      accepted: false,
      cancelled: true,
      activation: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('leaves an agent that cannot hold a structured session untouched, cancel or not', async () => {
    // Why: the module trusts its callers for the route, so the agent check is the last local
    // eligibility gate. Without it a dismissed creation reports itself cancelled for an agent that
    // was never going to open a session here.
    mocks.state = { pendingWorktreeCreations: {} }

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: { ...request, agent: 'gemini' },
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({ ...idle, activation: false, primaryTabId: null })
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
  })

  it('never marks an abandoned creation for a first-message rename', async () => {
    storeWithWorktree()
    const launchResult = Promise.reject(new StructuredAgentSessionCreateRefusalError('unsupported'))
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-refused',
      launchResult,
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn((fallback: () => Promise<void>) =>
        launchResult.catch(() => {
          // The user dismisses the creation between the loop's own check and the fallback body.
          mocks.state = { ...mocks.state, pendingWorktreeCreations: {} }
          return Promise.resolve()
            .then(fallback)
            .then(() => true)
        })
      )
    })

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    // Why: the workspace is being torn down, so a rename flag on it would never be consumed.
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps the terminal a finished fallback opened when the cancel lands after it', async () => {
    storeWithWorktree()
    refusedLaunch()
    mocks.activateAndRevealWorktree.mockImplementation(() => {
      // The user dismisses the creation only once the fallback's terminal is already up.
      mocks.state = { ...mocks.state, pendingWorktreeCreations: {} }
      mocks.listener?.(mocks.state)
      return { primaryTabId: 'terminal-tab' }
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      ...idle,
      accepted: false,
      cancelled: true,
      activation: { primaryTabId: 'terminal-tab' },
      primaryTabId: 'terminal-tab'
    })
    // Why: a refusal means no session exists on the host, so nothing is retired.
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('reports a known failure as accepted with the caller surface untouched', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.reject(new Error('boom')),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request,
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: { primaryTabId: 'tab-1' } as never,
        primaryTabId: 'tab-1'
      })
    ).resolves.toEqual({ ...idle, activation: { primaryTabId: 'tab-1' }, primaryTabId: 'tab-1' })
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('cancels and retires a session when its pending creation is dismissed', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const launchResult = new Promise<{ sessionId: string; fence: number }>((resolve) => {
      resolveLaunch = resolve
    })
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult,
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    const resultPromise = launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: {
        repoId: 'repo-1',
        name: 'routing-recovery',
        setupDecision: 'run',
        agent: 'codex',
        agentLaunchRoute: 'structured-native-chat',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: 'Fix the route',
        quickTelemetry: null
      },
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    mocks.state = { pendingWorktreeCreations: {} }
    mocks.listener?.(mocks.state)
    resolveLaunch({ sessionId: 'session-1', fence: 1 })

    await expect(resultPromise).resolves.toEqual({
      accepted: true,
      cancelled: true,
      visibilityUnknown: false,
      activation: false,
      primaryTabId: null
    })
    expect(mocks.cancelStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'session-1')
    expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
      worktree: { id: 'worktree-1' },
      tabId: 'agent-session:session-1',
      reason: 'user'
    })
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports an unknown launch without claiming a visible surface', async () => {
    const releaseCallerAfterUnknownOutcome = vi.fn()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-unknown',
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      releaseCallerAfterUnknownOutcome,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: {
          repoId: 'repo-1',
          name: 'routing-recovery',
          setupDecision: 'run',
          agent: 'codex',
          agentLaunchRoute: 'structured-native-chat',
          pendingFirstAgentMessageRename: false,
          note: '',
          startupPlan: null,
          quickPrompt: 'Fix the route',
          quickTelemetry: null
        },
        agentLaunchRoute: 'structured-native-chat',
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('activates the workspace before selecting a chat when creation deferred activation', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    const result = await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: {
        repoId: 'repo-1',
        name: 'routing-recovery',
        setupDecision: 'run',
        agent: 'codex',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: 'Fix the route',
        quickTelemetry: null
      },
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      providesInitialSurface: true
    })
    expect(mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateStructuredAgentSessionById.mock.invocationCallOrder[0]
    )
    expect(result.activation).toEqual({ primaryTabId: null })
  })
})
