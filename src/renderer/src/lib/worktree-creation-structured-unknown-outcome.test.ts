import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn(),
  launchStructuredWorktreeSession: vi.fn()
}))

const request: WorktreeCreationRequest = {
  repoId: 'repo-1',
  name: 'routing-recovery',
  setupDecision: 'run',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  workItemStartPromptDelivery: 'submit-after-ready',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: 'Recover the route',
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

type PendingCreationState = {
  activePendingCreationId: string | null
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
}
const pendingCreationState: PendingCreationState = {
  activePendingCreationId: 'creation-1',
  pendingWorktreeCreations: {}
}

const store = Object.assign(pendingCreationState, {
  activeView: 'terminal',
  repos: [],
  createWorktree: vi.fn(),
  updatePendingWorktreeCreation: vi.fn(
    (creationId: string, patch: Partial<PendingWorktreeCreation>) => {
      const entry = store.pendingWorktreeCreations[creationId]
      if (entry) {
        store.pendingWorktreeCreations[creationId] = { ...entry, ...patch }
      }
    }
  ),
  removePendingWorktreeCreation: vi.fn((creationId: string) => {
    delete store.pendingWorktreeCreations[creationId]
  }),
  updateWorktreeMeta: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn()
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))

vi.mock('@/lib/new-workspace', () => ({
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: vi.fn(async () => request),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn()
}))

vi.mock('@/lib/provisioned-root-create-options', () => ({
  getProvisionedRootCreateOptions: vi.fn()
}))

vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))

vi.mock('@/lib/worktree-draft-startup-view-mode', () => ({
  resolveBackendDraftStartup: vi.fn()
}))

vi.mock('@/lib/worktree-creation-flow-startup', () => ({
  buildWorktreeCreationStartupOpt: vi.fn()
}))

vi.mock('@/lib/worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: mocks.launchStructuredWorktreeSession
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: { value0?: string }) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'

describe('structured worktree creation unknown outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store.pendingWorktreeCreations = {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'worktree-1', repoId: 'repo-1' }
    })
    mocks.activateAndRevealWorktree.mockReturnValue(false)
    mocks.launchStructuredWorktreeSession.mockResolvedValue({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })
  })

  it('keeps the operation on its retry surface instead of reporting completion', async () => {
    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: 'Could not confirm whether Codex chat opened. Retry to check again.',
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRetryDisabled: false
    })
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('reconciles the created worktree on retry without creating another one', async () => {
    mocks.launchStructuredWorktreeSession
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: true,
        recovery: RECOVERY,
        activation: false,
        primaryTabId: null
      })
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        activation: false,
        primaryTabId: null
      })

    await executeWorktreeCreation('creation-1', request)
    // The pending entry persists the exact intent the retry must re-enter with.
    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRecoveryIntent: RECOVERY
    })
    retryBackgroundWorktreeCreation('creation-1')

    await vi.waitFor(() => expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(2))
    // One worktree, and the retry names the same session id and prompt operation.
    expect(store.createWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        request,
        worktreeId: 'worktree-1',
        recover: RECOVERY
      })
    )
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('admits only one retry while reconciliation is already running', async () => {
    let resolveRecovery:
      | ((value: {
          accepted: true
          cancelled: false
          visibilityUnknown: false
          activation: false
          primaryTabId: null
        }) => void)
      | undefined
    mocks.launchStructuredWorktreeSession
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: true,
        activation: false,
        primaryTabId: null
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRecovery = resolve
          })
      )

    await executeWorktreeCreation('creation-1', request)
    retryBackgroundWorktreeCreation('creation-1')
    retryBackgroundWorktreeCreation('creation-1')

    expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(2)
    expect(store.createWorktree).toHaveBeenCalledOnce()
    resolveRecovery?.({
      accepted: true,
      cancelled: false,
      visibilityUnknown: false,
      activation: false,
      primaryTabId: null
    })
  })

  it('fails closed when the launcher itself throws: no completion, no terminal, retryable error', async () => {
    // Reviewer counterexample one level above the helper: the caller's catch used to log and
    // fall through to `completeWorktreeCreation` with `structuredLaunchAccepted` still true.
    mocks.launchStructuredWorktreeSession.mockRejectedValueOnce(
      new Error('worktree_runtime_owner_ambiguous')
    )

    await executeWorktreeCreation('creation-1', request)

    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(store.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRetryDisabled: false
    })
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: expect.stringContaining('no terminal was started in its place'),
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRecoveryIntent: undefined,
      structuredLaunchRetryDisabled: false
    })
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(1)
  })

  it('keeps a strict launch failure on its retry surface instead of completing the creation', async () => {
    mocks.launchStructuredWorktreeSession.mockResolvedValueOnce({
      accepted: false,
      cancelled: false,
      visibilityUnknown: false,
      failure: 'structured-launch',
      activation: false,
      primaryTabId: null
    })

    await executeWorktreeCreation('creation-1', request)

    // The workspace exists with no writer: reported as an error the user can retry, never
    // completed, never handed a terminal.
    expect(store.removePendingWorktreeCreation).not.toHaveBeenCalled()
    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error: expect.stringContaining('no terminal was started in its place'),
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRecoveryIntent: undefined,
      structuredLaunchRetryDisabled: false
    })
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('keeps a definitive delivery failure on the existing worktree without retry', async () => {
    mocks.launchStructuredWorktreeSession.mockResolvedValue({
      accepted: true,
      cancelled: false,
      visibilityUnknown: false,
      failure: 'prompt-delivery',
      activation: false,
      primaryTabId: null
    })

    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        status: 'error',
        structuredLaunchRecoveryWorktreeId: 'worktree-1',
        structuredLaunchRetryDisabled: true
      })
    )
    retryBackgroundWorktreeCreation('creation-1')
    expect(store.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledOnce()
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('retries a proven-undelivered strict prompt on the same worktree and session', async () => {
    const retryRecovery = { ...RECOVERY, clientMessageId: 'message-retry' }
    mocks.launchStructuredWorktreeSession
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        failure: 'prompt-delivery',
        promptRetryable: true,
        recovery: retryRecovery,
        activation: false,
        primaryTabId: null
      })
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        activation: false,
        primaryTabId: null
      })

    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith(
      'creation-1',
      expect.objectContaining({
        status: 'error',
        structuredLaunchRecoveryWorktreeId: 'worktree-1',
        structuredLaunchRecoveryIntent: retryRecovery,
        structuredLaunchRetryDisabled: false
      })
    )
    retryBackgroundWorktreeCreation('creation-1')
    await vi.waitFor(() => expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(2))

    expect(store.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: 'worktree-1', recover: retryRecovery })
    )
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('reconciles an unconfirmed prompt on the existing worktree and session route', async () => {
    mocks.launchStructuredWorktreeSession
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        promptDeliveryUnknown: true,
        recovery: RECOVERY,
        activation: false,
        primaryTabId: null
      })
      .mockResolvedValueOnce({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        activation: false,
        primaryTabId: null
      })

    await executeWorktreeCreation('creation-1', request)

    expect(store.updatePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      status: 'error',
      error:
        'Could not confirm whether the work item prompt was delivered. Retry to reconcile the same message.',
      structuredLaunchRecoveryWorktreeId: 'worktree-1',
      structuredLaunchRecoveryIntent: RECOVERY,
      structuredLaunchRetryDisabled: false
    })

    retryBackgroundWorktreeCreation('creation-1')
    await vi.waitFor(() => expect(mocks.launchStructuredWorktreeSession).toHaveBeenCalledTimes(2))

    expect(store.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.launchStructuredWorktreeSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        creationId: 'creation-1',
        request,
        worktreeId: 'worktree-1',
        recover: RECOVERY
      })
    )
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })
})
