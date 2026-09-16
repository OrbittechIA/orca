import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'

export function markStructuredWorktreeLaunchUnconfirmed(
  creationId: string,
  worktreeId: string
): void {
  const store = useAppStore.getState()
  const agent = store.pendingWorktreeCreations[creationId]?.request.agent
  store.updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.launch.unknown',
      'Could not confirm whether {{value0}} chat opened. Retry to check again.',
      { value0: agent ? TUI_AGENT_DISPLAY_NAMES[agent] : 'agent' }
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
    activation: false,
    primaryTabId: null
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
