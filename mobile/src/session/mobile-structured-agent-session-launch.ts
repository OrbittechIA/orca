import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../src/shared/agent-session-wire'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../src/shared/agent-session-definitive-refusal'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams
} from '../../../src/shared/structured-agent-session-create'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import { hasRuntimeRpcErrorCode } from '../../../src/shared/runtime-rpc-error-code'
import type { RpcClient } from '../transport/rpc-client'
import {
  structuredAgentSessionCreate,
  structuredAgentSupportProbe
} from './mobile-session-launch-operations'
import { structuredSessionRandomUuid } from './structured-session-operation-id'

type StructuredCreateSupport = {
  supported?: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

const SELECTOR_NOT_RESOLVABLE_CODE = 'selector_not_found'
const CREATE_SUPPORT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type MobileStructuredAgentLaunchResult =
  /** `fence` only when the host returned one; delivery must name the create's fence. */
  | { kind: 'created'; sessionId: string; fence?: number }
  /**
   * `probeFailed` separates "the host refused" from "the host did not answer"; without it a lost
   * round trip reads as policy and a session that may exist is never reconciled.
   */
  | { kind: 'unsupported'; reason?: StructuredCreateSupport['reason']; probeFailed?: true }
  | { kind: 'failed'; message: string }
  | { kind: 'unknown'; message: string }

export type MobileStructuredAgentLaunchOptions = {
  launchOrigin?: 'work-item-start'
  /** A retry's recorded identity: reused so the host replays one create, never admits a second. */
  identity?: { sessionId: string; createClientOperationId: string }
}

/** A host that does not answer the probe in this window never refused; the caller reconciles. */
export const STRUCTURED_SUPPORT_PROBE_TIMEOUT_MS = 10_000

function createParamsFor(
  agent: AgentSessionHandleProvider,
  worktree: string,
  sessionId: string,
  options: MobileStructuredAgentLaunchOptions
): StructuredAgentSessionCreateParams {
  const params = structuredAgentSessionCreateParams({
    sessionId,
    worktree,
    agent,
    ...(options.launchOrigin ? { launchOrigin: options.launchOrigin } : {}),
    randomUuid: structuredSessionRandomUuid
  })
  // The fingerprint covers session id and fields, not the operation id, so the recorded id
  // rebuilds the exact envelope the first attempt sent.
  return options.identity
    ? {
        ...params,
        envelope: {
          ...params.envelope,
          clientOperationId: options.identity.createClientOperationId
        }
      }
    : params
}

function unknownCreateResult(
  agent: AgentSessionHandleProvider,
  error: unknown
): MobileStructuredAgentLaunchResult {
  const message = error instanceof Error ? error.message.trim() : ''
  return { kind: 'unknown', message: message || unconfirmedMessage(agent) }
}

function unconfirmedMessage(agent: AgentSessionHandleProvider): string {
  return `The ${TUI_AGENT_DISPLAY_NAMES[agent]} chat result could not be confirmed.`
}

function failedMessage(agent: AgentSessionHandleProvider): string {
  return `Could not open ${TUI_AGENT_DISPLAY_NAMES[agent]} chat.`
}

/** Only a refusal the host names as definitive may become `failed`; anything else keeps the
 *  outcome unknown so no legacy sibling terminal is created for a session that may exist. */
function classifyCreateRefusal(
  agent: AgentSessionHandleProvider,
  code: string,
  message: string
): MobileStructuredAgentLaunchResult {
  if (!isDefinitiveAgentSessionCreateRefusal(code)) {
    return unknownCreateResult(agent, new Error(message))
  }
  return { kind: 'failed', message: message || failedMessage(agent) }
}

export async function createMobileStructuredAgentSession(
  client: RpcClient,
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  options: MobileStructuredAgentLaunchOptions = {}
): Promise<MobileStructuredAgentLaunchResult> {
  const worktree = `id:${worktreeId}`
  // One id for probe and create: the scoped route admits the session the probe named, and a
  // second id would have the host admit one and receive another.
  const sessionId =
    options.identity?.sessionId ??
    createStructuredAgentSessionId(agent, structuredSessionRandomUuid)
  const supportParams = {
    worktree,
    agent,
    ...(options.launchOrigin ? { sessionId, launchOrigin: options.launchOrigin } : {})
  }
  let supportResponse
  for (let attempt = 0; ; attempt += 1) {
    try {
      supportResponse = await structuredAgentSupportProbe.request(client, supportParams, {
        timeoutMs: STRUCTURED_SUPPORT_PROBE_TIMEOUT_MS,
        budgetSpansConnect: true
      })
    } catch (error) {
      const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
      if (
        retryDelayMs === undefined ||
        !hasRuntimeRpcErrorCode(error, SELECTOR_NOT_RESOLVABLE_CODE)
      ) {
        // Transport failed: the host never answered, so it never refused.
        return { kind: 'unsupported', probeFailed: true }
      }
      await delay(retryDelayMs)
      continue
    }
    const retryDelayMs = CREATE_SUPPORT_RETRY_DELAYS_MS[attempt]
    if (
      retryDelayMs !== undefined &&
      hasRuntimeRpcErrorCode(supportResponse, SELECTOR_NOT_RESOLVABLE_CODE)
    ) {
      await delay(retryDelayMs)
      continue
    }
    break
  }
  if (
    !supportResponse ||
    typeof supportResponse !== 'object' ||
    typeof supportResponse.ok !== 'boolean' ||
    !supportResponse.ok
  ) {
    // A host without the method answered, and that answer is a verdict: no structured route.
    if (
      supportResponse?.ok === false &&
      isDefinitiveAgentSessionCreateRefusal(supportResponse.error?.code)
    ) {
      return { kind: 'unsupported' }
    }
    // A malformed reply or another `ok: false` is no verdict: the probe went unanswered.
    return { kind: 'unsupported', probeFailed: true }
  }
  const support = supportResponse.result as StructuredCreateSupport | null
  if (!support || typeof support !== 'object' || support.supported !== true) {
    return { kind: 'unsupported', reason: support?.reason }
  }

  const params = createParamsFor(agent, worktree, sessionId, options)
  let response
  try {
    response = await structuredAgentSessionCreate.request(client, params, {
      timeoutMs: 15_000,
      budgetSpansConnect: true
    })
  } catch {
    // Replay the durable envelope once so a lost acknowledgement cannot create a sibling.
    try {
      response = await structuredAgentSessionCreate.request(client, params, {
        timeoutMs: 15_000,
        budgetSpansConnect: true
      })
    } catch (retryError) {
      // A second transport error cannot disprove the first attempt committed.
      return unknownCreateResult(agent, retryError)
    }
  }

  // Why: this path distrusts the declared RpcResponse type — a malformed reply must read as
  // unconfirmed, not as a refusal we can classify.
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!response.ok) {
    const error = response.error as { code?: unknown; message?: unknown } | null | undefined
    if (
      !error ||
      typeof error !== 'object' ||
      typeof error.code !== 'string' ||
      typeof error.message !== 'string'
    ) {
      return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
    }
    return classifyCreateRefusal(agent, error.code, error.message)
  }
  const result = response.result as AgentSessionMutationResult<AgentSessionAttachResult>
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  if (!result.ok) {
    if (
      !result.refusal ||
      typeof result.refusal !== 'object' ||
      typeof result.refusal.code !== 'string' ||
      typeof result.refusal.message !== 'string'
    ) {
      return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
    }
    return classifyCreateRefusal(agent, result.refusal.code, result.refusal.message)
  }
  if (
    !result.value ||
    typeof result.value.sessionId !== 'string' ||
    !result.value.sessionId.trim()
  ) {
    return unknownCreateResult(agent, new Error(unconfirmedMessage(agent)))
  }
  // Fence only when it is real: a propagated `undefined` would become a fenceless send, and an
  // invented zero would collide with a session that already moved on.
  const fence = result.value.fence
  return {
    kind: 'created',
    sessionId: result.value.sessionId,
    ...(typeof fence === 'number' && Number.isSafeInteger(fence) ? { fence } : {})
  }
}
