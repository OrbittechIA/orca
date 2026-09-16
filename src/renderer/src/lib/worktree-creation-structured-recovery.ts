import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'

export function markStructuredWorktreeLaunchUnconfirmed(
  creationId: string,
  worktreeId: string
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.launch.unknown',
      'Could not confirm whether Codex chat opened. Retry to check again.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    // Explícito: um retry anterior pode tê-lo desligado, e reconciliar é permitido.
    structuredLaunchRetryDisabled: false
  })
}

/** Entrega sem confirmação: a MESMA mensagem é reconciliada, nunca reenviada. */
export function markStructuredWorktreePromptDeliveryUnconfirmed(
  creationId: string,
  worktreeId: string
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.prompt.unknown',
      'Could not confirm whether the work item prompt was delivered. Retry to reconcile the same message.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRetryDisabled: false
  })
}

/** Recusa definitiva: a workspace e a sessão ficam; reenviar abriria um segundo writer. */
export function markStructuredWorktreePromptDeliveryFailed(
  creationId: string,
  worktreeId: string
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.prompt.failed',
      'The structured agent session did not accept the work item prompt. Orca did not retry or start another writer.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRetryDisabled: true
  })
}

export async function retryStructuredWorktreeLaunch(
  creationId: string,
  request: WorktreeCreationRequest,
  worktreeId: string
): Promise<void> {
  if (!useAppStore.getState().pendingWorktreeCreations[creationId]) {
    return
  }
  const { agentLaunchRoute } = request
  // Why: this lane is entered only from an unconfirmed structured launch, so the persisted verdict
  // is that route; any other one names no session to reconcile.
  if (agentLaunchRoute !== 'structured-native-chat') {
    return
  }
  const structuredSession = await launchStructuredWorktreeSession({
    creationId,
    request,
    agentLaunchRoute,
    worktreeId,
    shouldActivateOnCompletion: true,
    fallbackStartupOpt: buildWorktreeCreationStartupOpt(request, false),
    activation: false,
    primaryTabId: null,
    recoverUnknownLaunch: true
  })
  if (structuredSession.cancelled) {
    return
  }
  if (structuredSession.visibilityUnknown) {
    markStructuredWorktreeLaunchUnconfirmed(creationId, worktreeId)
    return
  }
  if (structuredSession.promptDeliveryUnknown) {
    markStructuredWorktreePromptDeliveryUnconfirmed(creationId, worktreeId)
    return
  }
  if (structuredSession.failure === 'prompt-delivery') {
    markStructuredWorktreePromptDeliveryFailed(creationId, worktreeId)
    return
  }
  await completeWorktreeCreation({
    creationId,
    request,
    worktreeId,
    structuredLaunchAccepted: structuredSession.accepted,
    activation: structuredSession.activation,
    primaryTabId: structuredSession.primaryTabId,
    backendSpawned: false,
    focusOnCompletion: true
  })
}
