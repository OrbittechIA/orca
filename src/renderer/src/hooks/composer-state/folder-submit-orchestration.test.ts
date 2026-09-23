// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  toastError: vi.fn(),
  store: {
    activeRepoId: null,
    activeWorktreeId: null,
    projects: [],
    repos: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store begins unloaded and receives the same typed settings as the hook.
    settings: null as GlobalSettings | null,
    worktreesByRepo: {},
    seedNativeChatLaunchDraft: vi.fn(),
    updateFolderWorkspace: vi.fn(),
    // The provisional chat tab opens before the launch settles.
    unifiedTabsByWorktree: {},
    createUnifiedTab: vi.fn((_worktreeId: string, _type: string, tab: { id: string }) => tab),
    setActiveTabType: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.store }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch,
  cancelStructuredAgentLaunch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useFolderSubmitOrchestration } from './folder-submit-orchestration'

const linkedIssue = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 58,
  title: 'Canary issue',
  url: 'https://github.com/salvadorgu7/orca/issues/58',
  repoId: 'repo-1'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Start route reads `workItemStartPromptDelivery` only; the rest of GlobalSettings is never touched here.
const strictSettings = {
  experimentalStructuredNativeChat: false,
  experimentalNativeChat: false,
  workItemStartPromptDelivery: 'submit-after-ready'
} as GlobalSettings

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/repo/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Canary issue',
    folderPath: '/repo/platform/canary-issue',
    linkedTask: linkedIssue,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

type Input = Parameters<typeof useFolderSubmitOrchestration>[0]

function input(overrides: Partial<Input> = {}): Input {
  return {
    clearNewWorkspaceDraft: vi.fn(),
    createFolderWorkspace: vi.fn(async () => folderWorkspace()),
    decisions: {
      canResolveFolderSmartGitHubSubmit: () => false,
      getInitialAutoManagedWorkspaceName: () => '',
      getInitialGitHubPrStartPointSelection: () => null,
      getMatchingLinkedTaskSourceContext: () => null,
      isExplicitWorkspaceNameInput: () => false,
      resolveInitialWorkspaceRunSeed: () => ({
        projectId: null,
        hostId: null,
        projectHostSetupId: null
      }),
      resolveSmartGitHubCreateNames: () => ({ workspaceName: '', displayName: undefined }),
      retargetGitHubPrStartPointSelection: () => null
    },
    disabledTuiAgents: [],
    folderCreateDisabled: false,
    folderSourceRepos: [],
    folderTargetConnectionId: null,
    folderTargetIsRemote: false,
    folderTargetRuntimeEnvironmentId: null,
    isSubmissionCancelled: () => false,
    lastAutoNameRef: { current: '' },
    linkedWorkItem: linkedIssue,
    name: '',
    note: '',
    onCreated: vi.fn(),
    persistDraft: true,
    resolvePendingSmartGitHubSubmit: async () => ({ kind: 'none' }),
    selectedProjectGroup: projectGroup(),
    setCreateError: vi.fn(),
    setCreating: vi.fn(),
    settings: strictSettings,
    taskSourceContext: null,
    telemetrySource: 'sidebar',
    ...overrides
  }
}

async function submit(args: Input, agent: 'codex' | 'claude' = 'codex') {
  mocks.store.settings = args.settings
  const hook = renderHook(() => useFolderSubmitOrchestration(args))
  await act(() => hook.result.current.submitFolderTarget(agent))
}

beforeEach(() => {
  vi.clearAllMocks()
  setLocalRuntimeCapabilitiesForTests([
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
  ])
  Object.assign(window, {
    api: { agentTrust: { markTrusted: vi.fn().mockResolvedValue(undefined) } }
  })
  mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  mocks.startStructuredAgentLaunch.mockReturnValue({
    sessionId: 'session-1',
    launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
    promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false }),
    isVisibilityUnknown: () => false,
    releaseCallerAfterUnknownOutcome: vi.fn(),
    claimDefinitiveRefusalFallback: vi.fn()
  })
})
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
  Reflect.deleteProperty(window, 'api')
})

describe('folder composer production submit', () => {
  it.each(['codex', 'claude'] as const)(
    'uses one strict %s session with global chat off',
    async (agent) => {
      const args = input()
      await submit(args, agent)
      expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
      expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledExactlyOnceWith(
        folderWorkspaceKey('folder-workspace-1'),
        agent,
        {
          prompt: linkedIssue.url,
          promptDelivery: 'submit-after-ready',
          launchOrigin: 'work-item-start'
        }
      )
      expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledOnce()
      expect(mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]).not.toHaveProperty(
        'startup'
      )
      expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
      expect(args.clearNewWorkspaceDraft).toHaveBeenCalledOnce()
      expect(args.onCreated).toHaveBeenCalledOnce()
      expect(args.setCreateError).toHaveBeenCalledExactlyOnceWith(null)
    }
  )

  it.each([
    [
      'SSH',
      {
        selectedProjectGroup: projectGroup({ connectionId: 'ssh-1' }),
        folderTargetConnectionId: 'ssh-1',
        folderTargetIsRemote: true
      }
    ],
    [
      'WSL',
      {
        selectedProjectGroup: projectGroup({
          parentPath: String.raw`\\wsl.localhost\Ubuntu\home\alice\platform`
        })
      }
    ],
    ['paired runtime', { folderTargetRuntimeEnvironmentId: 'remote-1' }],
    [
      'custom command',
      { settings: { ...strictSettings, agentCmdOverrides: { codex: 'custom-codex' } } }
    ]
  ] satisfies [string, Partial<Input>][])(
    'refuses %s before creating',
    async (_name, overrides) => {
      const args = input(overrides)
      await submit(args)
      expect(args.createFolderWorkspace).not.toHaveBeenCalled()
      expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
      expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
      expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
      expect(args.setCreateError).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('No workspace, terminal, or prompt was started.')
        })
      )
      expect(args.onCreated).not.toHaveBeenCalled()
      expect(args.setCreating).toHaveBeenLastCalledWith(false)
    }
  )

  // Terminal arguments are not a structured-route input (the structured session ignores them), so
  // they neither block a strict Start nor reach the provider.
  it('keeps a strict Start structured when only terminal arguments are customized', async () => {
    const args = input({
      settings: { ...strictSettings, agentDefaultArgs: { codex: '--custom-flag' } }
    })
    await submit(args)
    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).toHaveBeenCalledOnce()
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('keeps draft on the terminal path', async () => {
    const args = input({ settings: { ...strictSettings, workItemStartPromptDelivery: 'draft' } })
    await submit(args)
    expect(args.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(mocks.startStructuredAgentLaunch).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith(
      'folder-workspace-1',
      expect.objectContaining({
        startup: expect.objectContaining({ draftPrompt: linkedIssue.url })
      })
    )
    expect(mocks.ensureAgentStartupInTerminal).toHaveBeenCalledOnce()
    expect(args.onCreated).toHaveBeenCalledOnce()
  })
})
