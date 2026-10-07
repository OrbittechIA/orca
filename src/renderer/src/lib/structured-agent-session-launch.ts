import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  abandonStructuredAgentSessionLaunchIntent,
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionCreateRefusalError
} from '@/lib/launch-structured-agent-session'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  discardStructuredAgentSessionLaunchOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  joinLaunchDelivery,
  outboxPromptText,
  stageLaunchPrompt,
  stageStrictRetryPrompt,
  withIntentLaunchOrigin
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
import {
  claimableStructuredLaunchAttempt,
  getStructuredLaunchStateForRequest
} from './structured-agent-session-launch-holders'
import {
  adoptPairedHostSeed,
  publishWithHeldOptions
} from './structured-agent-session-launch-options'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'
import {
  repeatedStructuredLaunchAttempt,
  structuredLaunchRequest,
  type StructuredLaunchRequest
} from './structured-agent-session-launch-request'

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
  /** What a retry must re-enter with if this launch's outcome ends up unknown. */
  recovery: StructuredAgentLaunchRecovery
  launchResult: Promise<StructuredAgentLaunchReceipt>
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
  if (state.callers.outcome === 'failed' || structuredLaunchCallersHavePendingWork(state.callers)) {
    return
  }
  cleanupLaunchState(state)
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
  state.promise = publishWithHeldOptions(
    state,
    wasVisibilityUnknown ? reconcileUnknownLaunch(state) : launchAndReconcile(state)
  )
  trackLaunchSettlement(state, state.promise)
  notifyStructuredLaunchListeners()
}

function joinStructuredLaunchState(
  existing: StructuredLaunchState,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions,
  request: StructuredLaunchRequest
): StructuredLaunchStateResult | undefined {
  // A re-delivery of the same action (a double click) shares the text it staged, so it is sent once.
  const repeat = repeatedStructuredLaunchAttempt(existing.callers.attempt, request.id)
  // An empty chat takes the first text sent to it, delivered the way that request asked.
  const claim = repeat ? undefined : claimableStructuredLaunchAttempt(existing, request)
  const retrying = existing.visibilityUnknown || existing.callers.outcome === 'failed'
  const joined = withIntentLaunchOrigin(
    joinLaunchDelivery(options, claim ? options.promptDelivery : existing.promptDelivery),
    existing.intent
  )
  // Why: an unconfirmed launch keeps its draft/outbox, so a recheck must not stage it twice.
  const text = retrying || repeat ? '' : outboxPromptText(joined)
  const strictRetry = retrying && !options.recover && isStrictWorkItemStartPrompt(joined)
  const stagedPrompt = options.recover
    ? stageLaunchPrompt(existing.intent.sessionId, joined)
    : strictRetry
      ? stageStrictRetryPrompt(existing.intent.sessionId, joined)
      : text
        ? enqueueStructuredAgentSessionLaunchPrompt(existing.intent.sessionId, text)
        : (repeat?.stagedEntry ?? null)
  // An unstaged claim stays unclaimed: the new launch it falls to reports the failure.
  if (claim && text && !stagedPrompt) {
    return undefined
  }
  if (retrying) {
    restartStructuredLaunchState(existing)
  }
  if (claim) {
    existing.promptDelivery = options.promptDelivery
    Object.assign(claim, { requestId: request.id, blank: false, stagedEntry: stagedPrompt })
  }
  if (!retrying && !repeat) {
    launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
  }
  // A re-delivery waits on the text its action staged, if any, and never stages its own.
  const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
  const callerOptions =
    options.recover || strictRetry
      ? joined
      : retrying || (repeat && !repeat.stagedEntry)
        ? joinedWithoutPrompt
        : joined
  return {
    state: existing,
    caller: addStructuredLaunchCaller({
      group: existing.callers,
      launchResult: existing.promise,
      target: existing.intent.target,
      options: callerOptions,
      stagedEntry: stagedPrompt
    })
  }
}

function structuredAgentLaunchState(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredLaunchStateResult {
  const identity = structuredLaunchIdentity(worktreeId, agent, options.resumeFrom)
  const request = structuredLaunchRequest(options)
  const recover = options.recover
  const existing = getStructuredLaunchStateForRequest(worktreeId, agent, identity, options, request)
  const joined = existing && joinStructuredLaunchState(existing, agent, options, request)
  if (joined) {
    return joined
  }

  const intent =
    recover?.intent ??
    createStructuredAgentSessionLaunchIntent(
      worktreeId,
      agent,
      options.executionHostId,
      options.resumeFrom,
      options.hostSeedOptions,
      options.launchOrigin
    )
  const text = outboxPromptText(options)
  const stagedPrompt = stageLaunchPrompt(intent.sessionId, options)
  launchDraft.seedStructuredAgentLaunchDraft(intent.sessionId, agent, options)
  const callers = createStructuredLaunchCallerGroup({
    kind: 'first',
    requestId: request.id,
    blank: !request.hasText,
    stagedEntry: stagedPrompt
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
  state.promise = recover
    ? // The session may already exist: look for it before replaying the same create.
      publishWithHeldOptions(state, reconcileUnknownLaunch(state))
    : text && !stagedPrompt
      ? Promise.reject(
          new StructuredAgentSessionCreateRefusalError(
            `Could not durably stage the ${structuredAgentLabel(agent)} launch prompt.`
          )
        )
      : publishWithHeldOptions(state, launchAndReconcile(state))
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
  discardStructuredAgentSessionLaunchOutbox(state.intent.sessionId)
  launchDraft.clearStructuredAgentLaunchDraft(state.intent.sessionId)
  abandonStructuredAgentSessionLaunchIntent(state.intent)
  notifyStructuredLaunchListeners()
  return true
}

export function startStructuredAgentLaunch(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: StructuredAgentLaunchOptions
): StructuredAgentLaunchResult {
  const { state, caller } = structuredAgentLaunchState(worktreeId, agent, options)
  return {
    sessionId: state.intent.sessionId,
    executionHostId: state.intent.executionHostId,
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

/** A message queued on a chat whose start never published relaunches it; the message goes out on
 *  publish. Shared by the chat's composer and by messages sent from elsewhere. */
export function relaunchFailedStructuredAgentSessionForMessage(
  worktreeId: string,
  sessionId: string
): void {
  if (getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed') {
    retryStructuredAgentSessionLaunch(worktreeId, sessionId)
  }
}
