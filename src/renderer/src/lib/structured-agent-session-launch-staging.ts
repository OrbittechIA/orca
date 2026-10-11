import type { TuiAgent } from '../../../shared/tui-agent'
import { StructuredAgentSessionCreateRefusalError } from './launch-structured-agent-session'
import { claimableStructuredLaunchAttempt } from './structured-agent-session-launch-holders'
import {
  repeatedStructuredLaunchAttempt,
  type StructuredLaunchRequest
} from './structured-agent-session-launch-request'
import {
  addStructuredLaunchCaller,
  type StructuredLaunchCaller,
  type StructuredAgentLaunchOptions
} from './structured-agent-session-launch-callers'
import { applyStructuredLaunchHeldOptions } from './structured-agent-session-launch-options'
import { reconcileUnknownLaunch } from './structured-agent-session-launch-recovery'
import * as launchDraft from './structured-agent-session-launch-draft'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionSendBody
} from '../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'
import {
  notifyStructuredLaunchListeners,
  setStructuredLaunchState
} from './structured-agent-session-launch-registry'
import { stageStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import type { WorkItemStartPromptIdentity } from './structured-agent-session-launch-persistence'

export function launchPromptText(options: StructuredAgentLaunchOptions): string {
  return options.promptDelivery === 'draft' ? '' : (options.prompt?.trim() ?? '')
}

export function joinLaunchDelivery(
  options: StructuredAgentLaunchOptions,
  established: StructuredAgentLaunchOptions['promptDelivery']
): StructuredAgentLaunchOptions {
  const mode = established ?? options.promptDelivery
  const { promptDelivery: _joinerMode, ...rest } = options
  return mode ? { ...rest, promptDelivery: mode } : rest
}

export function launchPromptFingerprint(sessionId: string, text: string): string {
  return agentSessionSendBodyFingerprint(sessionId, structuredAgentSessionSendBody(text, []))
}

export function stageLaunchPrompt(
  sessionId: string,
  options: StructuredAgentLaunchOptions,
  identity?: WorkItemStartPromptIdentity,
  requiresRetainedIdentity = false
): ReturnType<typeof stageStructuredLaunchPrompt> | null {
  const text = launchPromptText(options)
  if (!text) {
    return null
  }
  if (requiresRetainedIdentity && !identity) {
    return null
  }
  const strict = options.launchOrigin === 'work-item-start'
  const recovery =
    identity ??
    (options.recover?.clientMessageId && options.recover.bodyFingerprint
      ? {
          clientMessageId: options.recover.clientMessageId,
          bodyFingerprint: options.recover.bodyFingerprint
        }
      : undefined)
  if (options.recover && identity && options.recover.clientMessageId !== identity.clientMessageId) {
    return null
  }
  if (
    (options.recover || recovery) &&
    (!recovery ||
      !validPromptIdentity(recovery) ||
      recovery.bodyFingerprint !== launchPromptFingerprint(sessionId, text))
  ) {
    return null
  }
  return stageStructuredLaunchPrompt(sessionId, text, {
    ...(strict || options.promptKeptByCaller ? { callerKeepsText: true as const } : {}),
    ...(strict ? { workItemStart: true as const } : {}),
    ...(recovery ? { clientMessageId: recovery.clientMessageId } : {})
  })
}

export function withIntentLaunchOrigin(
  options: StructuredAgentLaunchOptions,
  intent: StructuredAgentSessionLaunchIntent
): StructuredAgentLaunchOptions {
  const launchOrigin = intent.params.launchOrigin ?? options.launchOrigin
  return launchOrigin ? { ...options, launchOrigin } : options
}

function validPromptIdentity(identity: WorkItemStartPromptIdentity): boolean {
  return (
    parseAgentSessionOperationTimestamp(identity.clientMessageId) !== null &&
    /^[0-9a-f]{64}$/.test(identity.bodyFingerprint)
  )
}

export function rememberPromptIdentity(
  state: StructuredLaunchState,
  stagedPrompt: ReturnType<typeof stageLaunchPrompt>
): void {
  if (state.intent.params.launchOrigin !== 'work-item-start' || !stagedPrompt?.clientMessageId) {
    return
  }
  state.promptIdentity = {
    clientMessageId: stagedPrompt.clientMessageId,
    bodyFingerprint: launchPromptFingerprint(state.intent.sessionId, stagedPrompt.text)
  }
}

export function trackStrictPrompt(
  state: StructuredLaunchState,
  caller: StructuredLaunchCaller,
  onSettled: () => void
): void {
  if (state.intent.params.launchOrigin !== 'work-item-start' || !caller.promptDeliveryResult) {
    return
  }
  caller.promptDeliveryResult = caller.promptDeliveryResult.then((result) => {
    const current = state.promptIdentity?.clientMessageId === caller.stagedClientMessageId
    if (
      !current &&
      state.promptIdentity?.clientMessageId !== result.retryClientMessageId &&
      (state.promptIdentity || result.retryClientMessageId)
    ) {
      return { delivered: false, deliveryUnknown: true as const, failureNotified: false }
    }
    if (result.delivered && current) {
      delete state.promptIdentity
    } else if (result.retryClientMessageId && current && state.promptIdentity) {
      const previous = state.promptIdentity
      state.promptIdentity = { ...previous, clientMessageId: result.retryClientMessageId }
      if (!setStructuredLaunchState(state)) {
        state.promptIdentity = previous
        setStructuredLaunchState(state)
        return { delivered: false, deliveryUnknown: true as const, failureNotified: false }
      }
    }
    notifyStructuredLaunchListeners()
    onSettled()
    return result
  })
}

export function joinStructuredLaunchState(
  existing: StructuredLaunchState,
  agent: TuiAgent,
  options: StructuredAgentLaunchOptions,
  request: StructuredLaunchRequest,
  lifecycle: {
    restart: (state: StructuredLaunchState) => void
    onSettled: (state: StructuredLaunchState) => void
  }
): { state: StructuredLaunchState; caller: StructuredLaunchCaller } {
  options = withIntentLaunchOrigin(options, existing.intent)
  if (
    options.recover &&
    (options.recover.intent.params.envelope.clientOperationId !==
      existing.intent.params.envelope.clientOperationId ||
      options.recover.intent.params.envelope.payloadFingerprint !==
        existing.intent.params.envelope.payloadFingerprint)
  ) {
    throw new StructuredAgentSessionCreateRefusalError(
      'Recovery does not match the original create operation.'
    )
  }
  const strict = options.launchOrigin === 'work-item-start'
  const recovering = !!options.recover || (strict && existing.callers.outcome === 'failed')
  const repeat = recovering
    ? undefined
    : repeatedStructuredLaunchAttempt(existing.callers.attempt, request.id)
  const claim = repeat || strict ? undefined : claimableStructuredLaunchAttempt(existing, request)
  const retrying = existing.visibilityUnknown || (strict && existing.callers.outcome === 'failed')
  const joined = joinLaunchDelivery(
    options,
    recovering ? options.promptDelivery : existing.promptDelivery
  )
  const promptMismatch =
    strict &&
    existing.promptIdentity &&
    existing.promptIdentity.bodyFingerprint !==
      launchPromptFingerprint(existing.intent.sessionId, joined.prompt?.trim() ?? '')
  const stagedPrompt = promptMismatch
    ? null
    : recovering
      ? stageLaunchPrompt(existing.intent.sessionId, joined, existing.promptIdentity, true)
      : (repeat?.stagedPrompt ??
        (retrying ? null : stageLaunchPrompt(existing.intent.sessionId, joined)))
  if (strict && (promptMismatch || !!launchPromptText(joined)) && !stagedPrompt?.clientMessageId) {
    stagedPrompt?.slot?.release()
    return {
      state: existing,
      caller: {
        stagedClientMessageId: null,
        promptDeliveryResult: Promise.resolve({
          delivered: false,
          deliveryUnknown: true,
          failureNotified: false
        })
      }
    }
  }
  if (!repeat) {
    rememberPromptIdentity(existing, stagedPrompt)
  }
  if (strict && !setStructuredLaunchState(existing)) {
    stagedPrompt?.slot?.release()
    throw new StructuredAgentSessionCreateRefusalError(
      'Could not save this Start operation for recovery.'
    )
  }
  if (retrying) {
    lifecycle.restart(existing)
  } else if (recovering) {
    existing.promise = reconcileUnknownLaunch(existing).then((receipt) =>
      applyStructuredLaunchHeldOptions(existing, receipt)
    )
  }
  if (claim) {
    existing.promptDelivery = options.promptDelivery
    Object.assign(claim, { requestId: request.id, blank: false, stagedPrompt })
  }
  if (!retrying && !repeat && !strict) {
    launchDraft.seedStructuredAgentLaunchDraft(existing.intent.sessionId, agent, joined)
  }
  const { prompt: _retryPrompt, ...joinedWithoutPrompt } = joined
  const callerOptions =
    !strict && (retrying || (repeat && !repeat.stagedPrompt)) ? joinedWithoutPrompt : joined
  const caller = addStructuredLaunchCaller({
    group: existing.callers,
    launchResult: existing.promise,
    target: existing.intent.target,
    options: callerOptions,
    stagedPrompt
  })
  trackStrictPrompt(existing, caller, () => lifecycle.onSettled(existing))
  return { state: existing, caller }
}
