import { useCallback } from 'react'
import { requireWorkItemStartPreflight } from '@/lib/work-item-start-preflight'
import { resolveWorkItemStartPromptDelivery } from '../../../../shared/work-item-start-prompt-delivery'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { ComposerModel } from './composer-model'
import type { PreparedQuickSubmit } from './composer-submit-model'
import type { QuickSubmitOptions } from './quick-creation-request'

type QuickWorkItemStartInput = Pick<
  ComposerModel,
  | 'ephemeralVmsEnabled'
  | 'selectedEphemeralVmRecipeId'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoTarget'
  | 'settings'
>

type PreparedWorkItemStart = Pick<
  PreparedQuickSubmit,
  'agent' | 'submitLinkedWorkItem' | 'trimmedNote'
>

export function useQuickWorkItemStart(input: QuickWorkItemStartInput) {
  const {
    ephemeralVmsEnabled,
    selectedEphemeralVmRecipeId,
    selectedRepoExecutionHostId,
    selectedRepoTarget,
    settings
  } = input
  return useCallback(
    async (
      { agent, submitLinkedWorkItem, trimmedNote }: PreparedWorkItemStart,
      repoId: string,
      workspaceRunContext: WorktreeCreationRequest['workspaceRunContext'],
      options?: QuickSubmitOptions
    ) => {
      const promptLinkedWorkItem = agent === null ? null : submitLinkedWorkItem
      const workItemDelivery = resolveWorkItemStartPromptDelivery(
        settings?.workItemStartPromptDelivery
      )
      const strictStart = Boolean(promptLinkedWorkItem && workItemDelivery === 'submit-after-ready')
      if (strictStart) {
        if (ephemeralVmsEnabled && selectedEphemeralVmRecipeId) {
          throw new Error(
            'Work Item Start cannot confirm support before creating this VM. Choose Draft.'
          )
        }
        if (
          options?.launchChoice?.executionHostId &&
          options.launchChoice.executionHostId !==
            (workspaceRunContext?.hostId ?? selectedRepoExecutionHostId)
        ) {
          throw new Error('The selected host differs from the Work Item Start preflight host.')
        }
        if (options?.launchChoice?.route === 'terminal-tui') {
          throw new Error('Choose Draft to start this work item in a terminal.')
        }
        const target = workspaceRunContext?.hostId
          ? ipcOrRuntimeTargetForHostId(workspaceRunContext.hostId)
          : (selectedRepoTarget ?? ipcOrRuntimeTargetForHostId(selectedRepoExecutionHostId))
        if (!target) {
          throw new Error('The Work Item Start execution host could not be confirmed.')
        }
        await requireWorkItemStartPreflight({ delivery: workItemDelivery, agent, repoId, target })
      }
      const { prompt: quickPrompt, draftPrompt: linkedDraftPrompt } =
        resolveQuickCreateLinkedWorkItemPrompt(promptLinkedWorkItem, trimmedNote)
      return {
        strictStart,
        quickPrompt,
        quickDraftPrompt: strictStart ? undefined : linkedDraftPrompt,
        launchPrompt: strictStart ? (linkedDraftPrompt ?? quickPrompt) : quickPrompt
      }
    },
    [
      ephemeralVmsEnabled,
      selectedEphemeralVmRecipeId,
      selectedRepoExecutionHostId,
      selectedRepoTarget,
      settings
    ]
  )
}
