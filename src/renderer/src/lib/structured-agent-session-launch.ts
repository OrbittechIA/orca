import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-agent-session'
import { discardStructuredAgentSessionLaunchOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  joinLaunchDelivery,
  outboxPromptText,
  stageLaunchPrompt,
  stageStrictRetryPrompt
} from '@/lib/structured-agent-session-launch-staging'
import {
  launchAndReconcile,
  reconcileUnknownLaunch,
  type StructuredAgentLaunchReceipt
} from '@/lib/structured-agent-session-launch-recovery'
import {
  isStrictWorkItemStartPrompt,
  type StructuredPromptDeliveryResult
} from '@/lib/structured-agent-session-launch-prompt'
import {
  addStructuredLaunchCaller,
  createStructuredLaunchCallerGroup,
  releaseStructuredLaunchCallerAfterUnknownOutcome,
  settleStructuredLaunchCallers,
  structuredLaunchCallersHavePendingWork,
  type StructuredAgentLaunchOptions,
  type StructuredAgentLaunchRecovery,
  type StructuredLaunchCaller
} from '@/lib/structured-agent-session-launch-callers'
import * as launchDraft from './structured-agent-session-launch-draft'
import { trackStructuredLaunchFailureToast } from './structured-agent-session-launch-failure-toast'
import {
  deleteStructuredLaunchStateIfCurrent,
  getStructuredLaunchState,
  getStructuredLaunchStateBySessionId,
  markStructuredAgentSessionLaunchCancelled,
  notifyStructuredLaunchListeners,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'

export type { StructuredAgentLaunchOptions, StructuredAgentLaunchReceipt }
export {
  getStructuredAgentLaunchStatus,
  getStructuredAgentSessionLaunchLifecycle,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  markStructuredAgentSessionLaunchCancelled,
  retireStructuredAgentSessionLaunchCancellationTombstone,
  shouldRetainStructuredAgentSessionLaunchTab,
  subscribeStructuredAgentLaunchStatus,
  useStructuredAgentSessionLaunchLifecycle,
  type StructuredAgentLaunchStatus,
  type StructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch-registry'
export { useStructuredAgentLaunchStatus } from './structured-agent-session-launch-status'

type StructuredLaunchStateResult = {
  state: StructuredLaunchState
  caller: StructuredLaunchCaller
}

export type StructuredAgentLaunchResult = {
  sessionId: string
  /** What a retry must re-enter with if this launch's outcome ends up unknown. */
  recovery: StructuredAgentLaunchRecovery
  launchResult: Promise<StructuredAgentLaunchReceipt>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  isVisibilityUnknown: () => boolean
  releaseCallerAfterUnknownOutcome: () => boolean
}

/** The durable intent, not the joining caller, decides whether a launch is a Work Item Start. */
function withIntentLaunchOrigin(
  options: StructuredAgentLaunchOptions,
  intent: StructuredLaunchState['intent']
): StructuredAgentLaunchOptions {
  const launchOrigin = intent.params.launchOrigin ?? options.launchOrigin
  return launchOrigin ? { ...options, launchOrigin } : options
}

function cleanupLaunchState(state: StructuredLaunchState): void {
  if (deleteStructuredLaunchStateIfCurrent(state)) {
    notifyStructuredLaunchListeners()
  }
}

function maybeCleanupLaunchState(state: StructuredLaunchState): void {
  if (state.callers.outcome === 'failed' || structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
}

function settleStructuredLaunchRefusal(state: StructuredLaunchState): void {
  if (state.callers.outcome !== 'pending' && state.callers.outcome !== 'unknown') {
    return
  }
  retireStructuredAgentSessionLaunchCancellationTombstone(
    state.intent.worktreeId,
    state.intent.sessionId
  )
  settleStructuredLaunchCallers(state.callers, 'failed')
  notifyStructuredLaunchListeners()
}

function trackLaunchSettlement(
  state: StructuredLaunchState,
  promise: Promise<StructuredAgentLaunchReceipt>
): void {
  void promise.then(
    () => {
      if (state.promise !== promise) {
        return
      }
      settleStructuredLaunchCallers(state.callers, 'published')
      notifyStructuredLaunchListeners()
    },
    (error) => {
      if (state.promise !== promise) {
        return
      }
      if (state.cancelled) {
        if (error instanceof StructuredAgentSessionCreateRefusalError) {
          retireStructuredAgentSessionLaunchCancellationTombstone(
            state.intent.worktreeId,
            state.intent.sessionId
          )
        }
        return
      }
      if (error instanceof StructuredAgentSessionCreateRefusalError) {
        settleStructuredLaunchRefusal(state)
      } else if (!state.visibilityUnknown) {
        settleStructuredLaunchCallers(state.callers, 'failed')
        notifyStructuredLaunchListeners()
      } else {
        state.callers.outcome = 'unknown'
        notifyStructuredLaunchListeners()
      }
    }
  )
}

function resetStructuredLaunchCallers(state: StructuredLaunchState): void {
  state.callers = createStructuredLaunchCallerGroup()
  state.callers.onSettled = () => maybeCleanupLaunchState(state)
}

function restartStructuredLaunchState(state: StructuredLaunchState): void {
  const wasVisibilityUnknown = state.visibilityUnknown
  if (!wasVisibilityUnknown) {
    state.intent = retryStructuredAgentSessionLaunchIntent(state.intent)
  }
  resetStructuredLaunchCallers(state)
  state.callers.outcome = 'pending'
  state.promise = wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchFailureToast(state.intent.agent, state.promise)
  notifyStructuredLaunchListeners()
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = structuredLaunchIdentity(worktreeId, agent, options.resumeFrom)
  const existing = getStructuredLaunchState(identity)
  if (existing) {
    const retrying = existing.visibilityUnknown || existing.callers.outcome === 'failed'
    if (retrying) {
      restartStructuredLaunchState(existing)
    }
    const joined = withIntentLaunchOrigin(
      joinLaunchDelivery(options, existing.promptDelivery),
      existing.intent
    )
    // Why: failed launches keep their draft/outbox, so a plain retry must not stage the same prompt
    // twice; a recovery finds the operation it staged before instead of dropping its delivery. A
    // strict retry re-attaches the prompt it never dispatched, or its Start could never complete.
    const strictRetry = retrying && !options.recover && isStrictWorkItemStartPrompt(joined)
    const restagesPrompt = !retrying || Boolean(options.recover) || strictRetry
    const stagedPrompt = !restagesPrompt
      ? null
      : strictRetry
        ? stageStrictRetryPrompt(existing.intent.sessionId, joined)
        : stageLaunchPrompt(existing.intent.sessionId, joined)
    if (!retrying) {
      launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
    }
    const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
    const callerOptions = restagesPrompt ? joined : joinedWithoutPrompt
    return {
      state: existing,
      caller: addStructuredLaunchCaller({
        group: existing.callers,
        launchResult: existing.promise,
        options: callerOptions,
        stagedEntry: stagedPrompt,
        target: existing.intent.target
      })
    }
  }

  // Only pass the third argument when adopting: every ordinary launch keeps the two-argument call
  // it has always made, so this change adds no trailing `undefined` for call-site assertions to
  // absorb.
  // A recovery re-enters with the intent it persisted: the same session id and create envelope
  // (the host replays that create, never a second session) and the prompt operation it staged.
  const recover = options.recover
  const intent = recover
    ? recover.intent
    : options.resumeFrom || options.launchOrigin
      ? createStructuredAgentSessionLaunchIntent(
          worktreeId,
          agent,
          options.resumeFrom,
          options.launchOrigin
        )
      : createStructuredAgentSessionLaunchIntent(worktreeId, agent)
  const text = outboxPromptText(options)
  const stagedPrompt = stageLaunchPrompt(intent.sessionId, options)
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup()
  const state: StructuredLaunchState = {
    identity,
    intent,
    promptDelivery: options.promptDelivery,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false,
    onVisibilityChanged: notifyStructuredLaunchListeners,
    callers
  }
  callers.onSettled = () => maybeCleanupLaunchState(state)
  state.promise = recover
    ? // The session may already exist: look for it before replaying the same create.
      reconcileUnknownLaunch(state)
    : text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            `Could not durably stage the ${structuredAgentLabel(agent)} launch prompt.`
          )
        )
      : launchAndReconcile(state)
  const caller = addStructuredLaunchCaller({
    group: state.callers,
    launchResult: state.promise,
    options: withIntentLaunchOrigin(options, intent),
    stagedEntry: stagedPrompt,
    target: state.intent.target
  })
  setStructuredLaunchState(state)
  notifyStructuredLaunchListeners()
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchFailureToast(state.intent.agent, state.promise)
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
  markStructuredAgentSessionLaunchCancelled(worktreeId, sessionId)
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions = {}
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    recovery: { intent: state.intent, clientMessageId: caller.stagedClientMessageId },
    launchResult: state.promise,
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
