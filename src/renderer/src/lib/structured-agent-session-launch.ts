import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError,
  retryStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'
import { discardStructuredAgentSessionChatSends } from '@/lib/structured-agent-session-launch-prompt'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredAgentLaunchReceipt
} from '@/lib/structured-agent-session-launch-recovery'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  structuredLaunchCallersHavePendingWork,
  type StructuredAgentLaunchOptions,
  type StructuredAgentLaunchRecovery,
  type StructuredLaunchCaller
} from '@/lib/structured-agent-session-launch-callers'
import * as launchDraft from './structured-agent-session-launch-draft'
import {
  deleteStructuredLaunchStateIfCurrent,
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { getStructuredLaunchStateForRequest } from './structured-agent-session-launch-holders'
import { applyStructuredLaunchHeldOptions } from './structured-agent-session-launch-options'
import {
  launchPromptText,
  stageLaunchPrompt,
  withIntentLaunchOrigin,
  rememberPromptIdentity,
  trackStrictPrompt,
  joinStructuredLaunchState
} from './structured-agent-session-launch-staging'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'
import { structuredLaunchRequest } from './structured-agent-session-launch-request'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }
export {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredAgentSessionLaunchResumes,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  shouldRetainStructuredAgentSessionLaunchTab,
  subscribeStructuredAgentLaunchStatus,
  useStructuredAgentSessionLaunchFailure,
  useStructuredAgentSessionLaunchLifecycle,
  type StructuredAgentLaunchStatus,
  type StructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch-registry'
export * from './structured-agent-session-launch-status'
export { useStructuredAgentSessionLaunchSelection } from './structured-agent-session-launch-options'

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredAgentLaunchResult = {
  sessionId: string
  executionHostId: ExecutionHostId
  launchResult: Promise<StructuredAgentLaunchReceipt>
  recovery: StructuredAgentLaunchRecovery
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (
    state.promptIdentity ||
    state.callers.outcome === 'failed' ||
    structuredLaunchCallersHavePendingWork(state.callers)
  ) {
    return
  }
  cleanupLaunchState(state)
}

/** Every sender waits on the launch promise, so picks held during launch reach the host first. */
function publishWithHeldOptions(
  state: StructuredLaunchState,
  created: Promise<StructuredAgentLaunchReceipt>
): Promise<StructuredAgentLaunchReceipt> {
  return created.then((receipt) => applyStructuredLaunchHeldOptions(state, receipt))
}

/** Each attempt's probe names the seed the paired server's create will use; the picker shows it. */
function adoptPairedHostSeed(
  state: StructuredLaunchState,
  seedOptions: StructuredLaunchState['selection']['seed']
): void {
  if (JSON.stringify(seedOptions) === JSON.stringify(state.intent.seedOptions)) {
    return
  }
  const { seedOptions: _previous, ...intent } = state.intent
  state.intent = seedOptions ? { ...intent, seedOptions } : intent
  state.selection = { ...state.selection, seed: seedOptions }
  notifyStructuredLaunchListeners()
}

function resetStructuredLaunchCallers(state: StructuredLaunchState): void {
  state.callers = createStructuredLaunchCallerGroup({ kind: 'retry' })
  state.callers.onSettled = () => maybeCleanupLaunchState(state)
}

function restartStructuredLaunchState(state: StructuredLaunchState): void {
  const wasVisibilityUnknown = state.visibilityUnknown
  if (!wasVisibilityUnknown) {
    state.intent = retryStructuredAgentSessionLaunchIntent(state.intent)
  }
  resetStructuredLaunchCallers(state)
  delete state.failure
  state.callers.outcome = 'pending'
  // A new create seeds from the settings of now (a paired server's arrive with its probe); picks
  // held through the failure still apply.
  state.selection = { ...state.selection, seed: state.intent.seedOptions }
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  const persisted = setStructuredLaunchState(state)
  state.promise =
    !persisted && state.intent.params.launchOrigin === 'work-item-start'
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            'Could not save this Start operation for recovery.'
          )
        )
      : publishWithHeldOptions(
          state,
          wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
        )
  trackLaunchSettlement(state, state.promise)
  notifyStructuredLaunchListeners()
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = structuredLaunchIdentity(worktreeId, agent, options.resumeFrom)
  const request = structuredLaunchRequest(options)
  let existing = getStructuredLaunchStateForRequest(worktreeId, agent, identity, options, request)
  if (options.recover && !existing) {
    restorePersistedStructuredLaunchState(worktreeId, options.recover.intent.sessionId)
    existing = getStructuredLaunchStateForRequest(worktreeId, agent, identity, options, request)
  }
  const joined =
    existing &&
    joinStructuredLaunchState(existing, agent, options, request, {
      restart: restartStructuredLaunchState,
      onSettled: maybeCleanupLaunchState
    })
  if (joined) {
    return joined
  }

  const intent =
    options.recover?.intent ??
    createStructuredAgentSessionLaunchIntent(
      worktreeId,
      agent,
      options.executionHostId,
      options.resumeFrom,
      options.hostSeedOptions,
      options.launchOrigin
    )
  options = withIntentLaunchOrigin(options, intent)
  const stagedPrompt = stageLaunchPrompt(intent.sessionId, options)
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup({
    kind: 'first',
    requestId: request.id,
    blank: !request.hasText,
    stagedPrompt
  })
  const state: StructuredLaunchState = {
    identity,
    intent,
    promptDelivery: options.promptDelivery,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    onVisibilityChanged: notifyStructuredLaunchListeners,
    callers,
    selection: { seed: intent.seedOptions, held: {} }
  }
  state.onHostSeed = (seedOptions) => adoptPairedHostSeed(state, seedOptions)
  callers.onSettled = () => maybeCleanupLaunchState(state)
  rememberPromptIdentity(state, stagedPrompt)
  const invalidStrictPrompt =
    options.launchOrigin === 'work-item-start' &&
    !!launchPromptText(options) &&
    !stagedPrompt?.clientMessageId
  const persisted = !invalidStrictPrompt && setStructuredLaunchState(state)
  state.promise =
    !persisted && options.launchOrigin === 'work-item-start'
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            'Could not save this Start operation for recovery.'
          )
        )
      : publishWithHeldOptions(
          state,
          options.recover ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
        )
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    target: state.intent.target,
    options,
    stagedPrompt
  })
  if (invalidStrictPrompt) {
    stagedPrompt?.slot?.release()
    caller.promptDeliveryResult = Promise.resolve({
      delivered: false,
      deliveryUnknown: true,
      failureNotified: false
    })
  }
  trackStrictPrompt(state, caller, () => maybeCleanupLaunchState(state))
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(state, state.promise)
  return {
    state,
    caller
  }
}

export function cancelStructuredAgentLaunch(worktreeId: string, sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    return false
  }
  markStructuredAgentSessionLaunchCancelled(worktreeId, sessionId, state.intent.executionHostId)
  discardStructuredAgentSessionChatSends(state.intent.sessionId)
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    executionHostId: state.intent.executionHostId,
    launchResult: state.promise,
    recovery: {
      intent: state.intent,
      clientMessageId: caller.stagedClientMessageId ?? options.recover?.clientMessageId ?? null,
      ...(state.promptIdentity ? { bodyFingerprint: state.promptIdentity.bodyFingerprint } : {})
    },
    ...(caller.promptDeliveryResult ? { promptDeliveryResult: caller.promptDeliveryResult } : {}),
    isVisibilityUnknown: () => state.visibilityUnknown,
    releaseCallerAfterUnknownOutcome: () =>
      releaseStructuredLaunchCallerAfterUnknownOutcome(state.callers, caller)
  }
}

export function retryStructuredAgentSessionLaunch(worktreeId: string, sessionId: string): boolean {
  const state =
    getStructuredLaunchStateBySessionId(sessionId) ??
    restorePersistedStructuredLaunchState(worktreeId, sessionId)
  if (
    state?.intent.worktreeId !== worktreeId ||
    (!state.visibilityUnknown && state.callers.outcome !== 'failed')
  ) {
    return false
  }
  restartStructuredLaunchState(state)
  return true
}

/** A message sent to a chat whose start never published relaunches it. Shared by the chat's
 *  composer and by messages sent from elsewhere. */
export function relaunchFailedStructuredAgentSessionForMessage(
  worktreeId: string,
  sessionId: string
): void {
  if (getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed') {
    retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  }
}
