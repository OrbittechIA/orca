import { requireWorkItemStartPreflight } from '@/lib/work-item-start-preflight'
import { resolveWorkItemStartPromptDelivery } from '../../../../shared/work-item-start-prompt-delivery'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { ComposerModel } from './composer-model'

type QuickCreationExecutionInput = Pick<
  ComposerModel,
  | 'clearNewWorkspaceDraft'
  | 'createMultiple'
  | 'effectivePresetId'
  | 'ephemeralVmRecipes'
  | 'ephemeralVmsEnabled'
  | 'isSubmissionCancelled'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'normalizedSparseDirectories'
  | 'onCreated'
  | 'parentWorktreeId'
  | 'persistDraft'
  | 'persistSetupAgentStartupPolicy'
  | 'prepareQuickSubmit'
  | 'resetForNextCreate'
  | 'resolvedInitialWorkspaceStatus'
  | 'selectedEphemeralVmRecipeId'
  | 'selectedRepoAgentLaunchFact'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoIsGit'
  | 'selectedRepoIsRemote'
  | 'selectedRepoTarget'
  | 'selectedRepoStartupShell'
  | 'selectedWorkspaceTarget'
  | 'settings'
  | 'sparseEnabled'
  | 'taskSourceContext'
  | 'telemetrySource'
>

import { useCallback } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { useAppStore } from '@/store'
import { isWorkspaceStatusAllowedOnHost } from '@/store/host-workspace-status-columns'
import { settleComposerSubmit } from '@/lib/composer-submit-cancellation'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import type { ComposerCreateHandoff } from '@/lib/composer-create-handoff'
import { translate } from '@/i18n/i18n'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { buildQuickComposerStartup } from './quick-startup-plan'
import { buildQuickCreationRequest, type QuickSubmitOptions } from './quick-creation-request'
import type { PendingSmartGitHubSubmitResolution } from './source-selection-decisions'
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'

export function useQuickCreationExecution(input: QuickCreationExecutionInput) {
  const {
    clearNewWorkspaceDraft,
    createMultiple,
    effectivePresetId,
    ephemeralVmRecipes,
    ephemeralVmsEnabled,
    isSubmissionCancelled,
    linkedGitLabIssue,
    linkedGitLabMR,
    normalizedSparseDirectories,
    onCreated,
    parentWorktreeId,
    persistDraft,
    persistSetupAgentStartupPolicy,
    prepareQuickSubmit,
    resetForNextCreate,
    resolvedInitialWorkspaceStatus,
    selectedEphemeralVmRecipeId,
    selectedRepoAgentLaunchFact,
    selectedRepoExecutionHostId,
    selectedRepoIsGit,
    selectedRepoIsRemote,
    selectedRepoTarget,
    selectedRepoStartupShell,
    selectedWorkspaceTarget,
    settings,
    sparseEnabled,
    taskSourceContext,
    telemetrySource
  } = input

  const executeQuickCreation = useCallback(
    async (
      smartGitHubResolution: PendingSmartGitHubSubmitResolution,
      requestedAgent: TuiAgent | null,
      workspaceNameSeed: string,
      workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'],
      repoId: string,
      options?: QuickSubmitOptions,
      handoff?: ComposerCreateHandoff
    ): Promise<void> => {
      const prepared = await prepareQuickSubmit(
        smartGitHubResolution,
        requestedAgent,
        workspaceNameSeed
      )

      if (!prepared) {
        return
      }

      const {
        submitLinkedWorkItem,
        agent,
        submitLinkedIssueNumber,
        submitLinkedPR,
        workspaceName,
        nameWasGenerated,
        nameIsAutoManaged,
        submitCompareBaseRef,
        submitPushTarget,
        effectiveSetupDecision,
        hookPreparation,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        effectiveBranchNameOverride,
        branchIntent,
        submitBaseBranch,
        createDisplayName,
        pendingFirstAgentMessageRename,
        trimmedNote
      } = prepared

      const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem
      const workItemDelivery = resolveWorkItemStartPromptDelivery(settings?.workItemStartPromptDelivery)
      const strictStart = Boolean(promptLinkedWorkItem && workItemDelivery === 'submit-after-ready')
      if (strictStart) {
        if (ephemeralVmsEnabled && selectedEphemeralVmRecipeId) {
          throw new Error('Work Item Start cannot confirm support before creating this VM. Choose Draft.')
        }
        if (options?.launchChoice?.executionHostId && options.launchChoice.executionHostId !== (workspaceRunContext?.hostId ?? selectedRepoExecutionHostId)) {
          throw new Error('The selected host differs from the Work Item Start preflight host.')
        }
        if (options?.launchChoice?.route === 'terminal-tui') {
          throw new Error('Choose Draft to start this work item in a terminal.')
        }
        const target = workspaceRunContext?.hostId
          ? ipcOrRuntimeTargetForHostId(workspaceRunContext.hostId)
          : selectedRepoTarget ?? ipcOrRuntimeTargetForHostId(selectedRepoExecutionHostId)
        if (!target) throw new Error('The Work Item Start execution host could not be confirmed.')
        await requireWorkItemStartPreflight({ delivery: workItemDelivery, agent, repoId, target })
      }

      const { prompt: quickPrompt, draftPrompt: linkedDraftPrompt } =
        resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem, trimmedNote)
      const quickDraftPrompt = strictStart ? undefined : linkedDraftPrompt
      const launchPrompt = strictStart ? (linkedDraftPrompt ?? quickPrompt) : quickPrompt

      const {
        startupPlan,
        backendStartup,
        telemetry: quickTelemetry
      } = strictStart ? { startupPlan: null, backendStartup: undefined, telemetry: null } : buildQuickComposerStartup({
        agent,
        prompt: quickPrompt,
        draftPrompt: quickDraftPrompt,
        settings,
        launchHost: selectedRepoAgentLaunchFact,
        shell: selectedRepoStartupShell,
        isRemote: selectedRepoIsRemote,
        telemetrySource
      })

      const startupPolicySettlement = await settleComposerSubmit(
        persistSetupAgentStartupPolicy(),
        isSubmissionCancelled
      )

      if (startupPolicySettlement.status === 'cancelled') {
        return
      }

      if (!startupPolicySettlement.value) {
        throw new Error(
          translate(
            'auto.hooks.useComposerState.setupAgentStartupPolicySaveFailed',
            'Failed to save setup startup behavior.'
          )
        )
      }

      let ephemeralVmRecipe: WorktreeCreationRequest['ephemeralVmRecipe']

      const activeEphemeralVmRecipeId = ephemeralVmsEnabled ? selectedEphemeralVmRecipeId : null

      if (activeEphemeralVmRecipeId && selectedWorkspaceTarget.status === 'ready') {
        const selectedRecipe = ephemeralVmRecipes.find(
          (recipe) => recipe.id === activeEphemeralVmRecipeId
        )
        ephemeralVmRecipe = {
          sourceRepoId: repoId,
          recipeId: activeEphemeralVmRecipeId,
          projectId: selectedWorkspaceTarget.target.projectId,
          ...(selectedRecipe?.checkoutMode ? { checkoutMode: selectedRecipe.checkoutMode } : {})
        }
      }

      const promptDelivery = strictStart ? 'submit-after-ready' : quickDraftPrompt ? 'draft' : 'auto-submit'
      // Why: the verdict is persisted on the request as data and re-entered once the worktree exists.
      const agentLaunchRoute = !agent
        ? 'terminal-tui'
        : strictStart ? 'structured-native-chat' : (options?.launchChoice?.route ??
          resolveAgentSessionLaunchRoute(useAppStore.getState(), {
            agent,
            workspace: {
              kind: selectedRepoIsGit ? 'git-worktree' : 'folder',
              repoId,
              executionHostId: ephemeralVmRecipe
                ? 'runtime:pending-ephemeral-vm'
                : (workspaceRunContext?.hostId ?? selectedRepoExecutionHostId ?? undefined)
            },
            prompt: quickDraftPrompt ?? quickPrompt,
            promptDelivery
          }))
      const structuredLaunch = agentLaunchRoute === 'structured-native-chat'

      const request = buildQuickCreationRequest({
        repoId,
        ephemeralVmRecipe,
        indeterminateProgress:
          Boolean(activeEphemeralVmRecipeId) || selectedRepoTarget?.kind === 'environment',
        taskSourceContext,
        linkedWorkItem: submitLinkedWorkItem,
        workspaceRunContext,
        workspaceName,
        nameWasGenerated,
        displayName: createDisplayName,
        displayNameKind: createDisplayName ? (nameIsAutoManaged ? 'generated' : 'user') : undefined,
        selectedRepoIsGit,
        baseBranch: submitBaseBranch,
        compareBaseRef: submitCompareBaseRef,
        setupDecision: effectiveSetupDecision,
        sparseDirectories: selectedRepoIsGit && sparseEnabled ? normalizedSparseDirectories : null,
        sparsePresetId: effectivePresetId,
        telemetrySource,
        linkedIssue: submitLinkedIssueNumber,
        linkedPR: submitLinkedPR,
        pushTarget: submitPushTarget,
        agent,
        agentLaunchRoute,
        linkedLinearIssue,
        linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey,
        branchNameOverride: effectiveBranchNameOverride,
        branchIntent,
        parentWorktreeId,
        // A lane's host-only column applies only when creating on that host.
        workspaceStatus:
          resolvedInitialWorkspaceStatus &&
          isWorkspaceStatusAllowedOnHost(
            useAppStore.getState(),
            {
              hostId: workspaceRunContext?.hostId ?? selectedRepoExecutionHostId,
              runtimeOwnerEnvironmentId:
                selectedRepoTarget?.kind === 'environment' ? selectedRepoTarget.environmentId : null
            },
            resolvedInitialWorkspaceStatus
          )
            ? resolvedInitialWorkspaceStatus
            : undefined,
        linkedGitLabMR,
        linkedGitLabIssue,
        includeGitLabLinks: smartGitHubResolution.kind === 'none',
        startup: structuredLaunch ? undefined : backendStartup,
        hookPreparation: ephemeralVmRecipe
          ? {
              ...hookPreparation,
              executionHostId: selectedRepoExecutionHostId ?? undefined,
              confirmVmRecipe: true
            }
          : hookPreparation,
        pendingFirstAgentMessageRename,
        note: trimmedNote,
        startupPlan,
        quickPrompt: launchPrompt,
        ...(strictStart ? { launchOrigin: 'work-item-start' as const } : {}),
        launchDraftPrompt: quickDraftPrompt,
        promptDelivery,
        quickTelemetry,
        suppressTerminalFocusOnCompletion: createMultiple,
        setupOnly: options?.setupOnly === true
      })

      if (isSubmissionCancelled()) {
        return
      }

      if (persistDraft) {
        clearNewWorkspaceDraft()
      }

      if (handoff) {
        handoff.start(request)
      } else {
        runBackgroundWorktreeCreation(request)
      }

      // The composer already closed at handoff; closing again could dismiss a newer modal.
      if (handoff?.isHandedOff()) {
        return
      }

      if (createMultiple) {
        resetForNextCreate()
      } else {
        onCreated?.()
      }
    },
    [
      clearNewWorkspaceDraft,
      createMultiple,
      effectivePresetId,
      ephemeralVmRecipes,
      ephemeralVmsEnabled,
      isSubmissionCancelled,
      linkedGitLabIssue,
      linkedGitLabMR,
      normalizedSparseDirectories,
      onCreated,
      parentWorktreeId,
      persistDraft,
      persistSetupAgentStartupPolicy,
      prepareQuickSubmit,
      resetForNextCreate,
      resolvedInitialWorkspaceStatus,
      selectedEphemeralVmRecipeId,
      selectedRepoAgentLaunchFact,
      selectedRepoExecutionHostId,
      selectedRepoIsGit,
      selectedRepoIsRemote,
      selectedRepoTarget,
      selectedRepoStartupShell,
      selectedWorkspaceTarget,
      settings,
      sparseEnabled,
      taskSourceContext,
      telemetrySource
    ]
  )

  return {
    executeQuickCreation
  }
}
