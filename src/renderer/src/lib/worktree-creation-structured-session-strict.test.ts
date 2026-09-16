import { beforeEach, describe, expect, it, vi } from 'vitest'

// Strict (`submit-after-ready`) Work Item Start through quick-create: fail-closed on refusal,
// on a thrown launch, on a generic failed settlement, and on missing delivery evidence.

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

describe('strict Work Item Start (submit-after-ready)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { pendingWorktreeCreations: { 'creation-1': {} } }
    mocks.listener = null
    mocks.closeStructuredAgentSession.mockResolvedValue('closed')
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
    mocks.updateWorktreeMeta.mockResolvedValue(undefined)
    mocks.preflightAgentTrust.mockResolvedValue(undefined)
  })
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

  it('fails closed when launch-intent creation throws (ambiguous runtime owner): no completion, no terminal', async () => {
    // Reviewer counterexample: the sync prologue of the launch throws before any create
    // (`runtimeTargetForWorktreeOwner` refusing an ambiguous owner). The catch path used to
    // answer `accepted: true`, and the creation completed on nothing.
    storeWithWorktree()
    mocks.startStructuredAgentLaunch.mockImplementation(() => {
      throw new Error('worktree_runtime_owner_ambiguous')
    })
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
      failure: 'structured-launch',
      activation: false,
      primaryTabId: null
    })
    expect(result.promptDeliveryUnknown).toBeUndefined()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).not.toHaveBeenCalled()
    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
  })

  it('fails closed on a generic failed settlement: no completion, no terminal', async () => {
    // A launch that rejects with a known, non-refusal outcome settles `{ kind: 'failed' }`;
    // strict mode must not read that as an accepted creation.
    storeWithWorktree()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      recovery: RECOVERY,
      launchResult: Promise.reject(new Error('provider child exited before attach')),
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
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

    expect(result).toMatchObject({ accepted: false, failure: 'structured-launch' })
    const launch = mocks.startStructuredAgentLaunch.mock.results[0]?.value as {
      claimDefinitiveRefusalFallback: ReturnType<typeof vi.fn>
    }
    expect(launch.claimDefinitiveRefusalFallback).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).not.toHaveBeenCalled()
  })

  it('never reads missing delivery evidence as success: no delivery state is durable unknown', async () => {
    // Reviewer counterexample: a launch that resolves with a session but carries NO prompt
    // delivery state at all. Strict mode must not complete the creation on that silence.
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
      request: strictRequest,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })
    expect(result.promptDeliveryUnknown === true || result.failure !== undefined).toBe(true)
    expect(result).toMatchObject({ promptDeliveryUnknown: true, recovery: RECOVERY })
    // One launch, no fallback: nothing mints a second session or a terminal. The only
    // activation is the structured chat's own (`providesInitialSurface`), never a startup terminal.
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      providesInitialSurface: true
    })
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.ensureWebRuntimeWorktreeTerminalAfterWake).not.toHaveBeenCalled()
    expect(mocks.preflightAgentTrust).not.toHaveBeenCalled()
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
