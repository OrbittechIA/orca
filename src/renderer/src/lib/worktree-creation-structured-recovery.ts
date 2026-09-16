import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { completeWorktreeCreation } from '@/lib/worktree-creation-completion'
import {
  launchStructuredWorktreeSession,
  type WorktreeCreationStructuredSessionResult
} from '@/lib/worktree-creation-structured-session'

type StructuredRecovery = Pick<WorktreeCreationStructuredSessionResult, 'recovery'>

export function markStructuredWorktreeLaunchUnconfirmed(
  creationId: string,
  worktreeId: string,
  { recovery }: StructuredRecovery = {}
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
    // The retry must reconcile THIS session and THIS prompt operation, not mint new ones.
    ...(recovery ? { structuredLaunchRecoveryIntent: recovery } : {}),
    // Explícito: um retry anterior pode tê-lo desligado, e reconciliar é permitido.
    structuredLaunchRetryDisabled: false
  })
}

/** Entrega sem confirmação: a MESMA mensagem é reconciliada, nunca reenviada. */
export function markStructuredWorktreePromptDeliveryUnconfirmed(
  creationId: string,
  worktreeId: string,
  { recovery }: StructuredRecovery = {}
): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.prompt.unknown',
      'Could not confirm whether the work item prompt was delivered. Retry to reconcile the same message.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    ...(recovery ? { structuredLaunchRecoveryIntent: recovery } : {}),
    structuredLaunchRetryDisabled: false
  })
}

/** Recusa definitiva do create estrito: a workspace existe sem writer, nada abriu no lugar.
 *  O host provou que não criou nada, então o retry pode tentar uma sessão nova. */
export function markStructuredWorktreeLaunchRefused(creationId: string, worktreeId: string): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.launch.refused',
      'The host refused the structured agent session for this work item. The workspace was created without an agent; no terminal was started in its place. Retry to try the session again.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRecoveryIntent: undefined,
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

/** O launch estrito não chegou a uma sessão: sem writer, sem terminal; o retry tenta de novo. */
export function markStructuredWorktreeLaunchFailed(creationId: string, worktreeId: string): void {
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: translate(
      'auto.lib.worktree.creation.flow.structured.launch.failed',
      'The structured agent session for this work item could not be started. The workspace was created without an agent; no terminal was started in its place. Retry to try the session again.'
    ),
    structuredLaunchRecoveryWorktreeId: worktreeId,
    structuredLaunchRecoveryIntent: undefined,
    structuredLaunchRetryDisabled: false
  })
}

/**
 * Every non-completing outcome of a structured quick-create launch, marked on the pending entry
 * so Retry re-enters the right lane. Returns `false` when the launch completed (or was cancelled)
 * and the caller should proceed.
 */
export function markStructuredWorktreeLaunchOutcome(
  creationId: string,
  worktreeId: string,
  result: WorktreeCreationStructuredSessionResult
): boolean {
  if (result.visibilityUnknown) {
    markStructuredWorktreeLaunchUnconfirmed(creationId, worktreeId, result)
  } else if (result.promptDeliveryUnknown) {
    markStructuredWorktreePromptDeliveryUnconfirmed(creationId, worktreeId, result)
  } else if (result.failure === 'prompt-delivery') {
    markStructuredWorktreePromptDeliveryFailed(creationId, worktreeId)
  } else if (result.failure === 'structured-refused') {
    markStructuredWorktreeLaunchRefused(creationId, worktreeId)
  } else if (result.failure === 'structured-launch') {
    markStructuredWorktreeLaunchFailed(creationId, worktreeId)
  } else {
    return false
  }
  return true
}

export async function retryStructuredWorktreeLaunch(
  creationId: string,
  request: WorktreeCreationRequest,
  worktreeId: string,
  recover?: WorktreeCreationStructuredSessionResult['recovery']
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
    primaryTabId: null,
    ...(recover ? { recover } : {})
  })
  if (
    structuredSession.cancelled ||
    markStructuredWorktreeLaunchOutcome(creationId, worktreeId, structuredSession)
  ) {
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
