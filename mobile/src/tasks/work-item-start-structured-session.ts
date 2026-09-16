import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { resolveWorkItemStartPromptDelivery } from '../../../src/shared/agent-session-options'
import { structuredAgentSessionPayloadFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import { requestStructuredAgentSessionMutation } from '../session/mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import {
  clearMobileStructuredSendOperation,
  getOrCreateMobileStructuredSendOperation,
  mobileStructuredSendOperationKey
} from '../session/mobile-structured-send-operation-journal'
import type { RpcClient } from '../transport/rpc-client'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'
import { workItemStartAdmissionRead } from './mobile-workspace-create-operations'

/**
 * Whether this host's Work Item Start must produce a structured agent session.
 *
 * `submit-after-ready` is the same switch the host reads in
 * `supportsWorkItemStartStructuredSessionCreate`, so client and host agree on which starts are
 * structured without the client inventing a second preference.
 */
export function workItemStartRequiresStructuredSession(
  settings: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined
): boolean {
  return (
    resolveWorkItemStartPromptDelivery(settings?.workItemStartPromptDelivery) ===
    'submit-after-ready'
  )
}

/**
 * Whether the host this client is paired with admits the scoped Work Item Start create.
 *
 * Two independent facts, both host-owned. The capability says this build has the route at all —
 * dropping the terminal startup against a host without it would leave an agentless workspace. The
 * scope says this pairing may use it: `structuredWorkItemStartCallerAuthority` admits only a
 * `runtime` caller, so a phone paired with `mobile` scope is refused no matter the settings, and
 * must keep the terminal it has always had.
 */
export type WorkItemStartHostAdmission = {
  capabilities?: readonly string[]
  deviceScope?: string
}

/** A host that does not answer its status within this window has not admitted anything. */
export const WORK_ITEM_START_ADMISSION_TIMEOUT_MS = 10_000

/**
 * Reads the host's admission once per Start. A probe that cannot answer returns `null`: the
 * host neither admitted nor refused, and a strict Start stops there rather than guessing.
 */
export async function readWorkItemStartHostAdmission(
  client: RpcClient
): Promise<WorkItemStartHostAdmission | null> {
  try {
    const status = workItemStartAdmissionRead.interpret(
      await workItemStartAdmissionRead.request(client, undefined, {
        timeoutMs: WORK_ITEM_START_ADMISSION_TIMEOUT_MS
      })
    )
    if (!status.accepted) {
      return null
    }
    const result = status.value
    return {
      ...(Array.isArray(result.capabilities) ? { capabilities: result.capabilities } : {}),
      ...(typeof result.deviceScope === 'string' ? { deviceScope: result.deviceScope } : {})
    }
  } catch {
    return null
  }
}

export function workItemStartHostAdmitsStructuredSession(
  host: WorkItemStartHostAdmission | null | undefined
): boolean {
  return (
    host?.deviceScope === 'runtime' &&
    host.capabilities?.includes(WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY) === true
  )
}

/** Only providers with a durable session handle can carry an authoritative identity. */
export function workItemStartAgentSupportsStructuredSession(
  agent: TuiAgent | 'blank' | undefined
): boolean {
  return agent !== undefined && agent !== 'blank' && isAgentSessionHandleProvider(agent)
}

/**
 * How a Work Item Start must begin, decided BEFORE `worktree.create`.
 *
 * - `terminal`: draft mode, or no agent — the Start this client has always done.
 * - `structured`: strict mode and the host admits the scoped route for this pairing.
 * - `refused`: strict mode and the host said no (an older build without the route, or a
 *   pairing scoped `mobile`). Nothing is created: a terminal in the session's place would be
 *   the unidentifiable writer strict mode exists to prevent.
 * - `unknown`: strict mode and the host never answered (timeout, transport, malformed status).
 *   Not a refusal, not an admission; nothing is created until it can be asked again.
 *
 * Tri-state on purpose: a boolean collapsed `refused` and `unknown` into "terminal", which
 * silently degraded a strict Start into the legacy terminal.
 */
export type WorkItemStartRoute =
  | { kind: 'terminal' }
  | { kind: 'structured' }
  | { kind: 'refused'; message: string }
  | { kind: 'unknown'; message: string }

export const WORK_ITEM_START_ROUTE_MESSAGES = {
  refused:
    'Work Item Start is set to submit after ready, but this host does not admit the structured session for this pairing (an older host, or a pairing without runtime scope). Nothing was created; no terminal was started in its place. Update the host or set Work Item Start back to draft.',
  unknown:
    'Work Item Start is set to submit after ready, but this host did not answer whether it admits the structured session. Nothing was created. Check the connection and try again.'
} as const

/**
 * The one decision both Work Item Start entry points share: this host asked for
 * `submit-after-ready`, this pairing is admitted, and this agent is not `blank`.
 * The agent's own structured support is checked separately, because only once the host
 * admits the route does an unsupported agent become a refusal rather than a plain terminal Start.
 */
export async function resolveWorkItemStartRoute(args: {
  client: RpcClient
  settings: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined
  agent: TuiAgent | 'blank' | undefined
}): Promise<WorkItemStartRoute> {
  if (args.agent === undefined || args.agent === 'blank') {
    return { kind: 'terminal' }
  }
  if (!workItemStartRequiresStructuredSession(args.settings)) {
    return { kind: 'terminal' }
  }
  const admission = await readWorkItemStartHostAdmission(args.client)
  if (admission === null) {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.unknown }
  }
  return workItemStartHostAdmitsStructuredSession(admission)
    ? { kind: 'structured' }
    : { kind: 'refused', message: WORK_ITEM_START_ROUTE_MESSAGES.refused }
}

/** Kept for callers that only need the admitted case; a strict Start must read the route. */
export async function workItemStartShouldUseStructuredSession(
  args: Parameters<typeof resolveWorkItemStartRoute>[0]
): Promise<boolean> {
  return (await resolveWorkItemStartRoute(args)).kind === 'structured'
}

export type WorkItemStartStructuredSessionResult =
  /** The session exists and the prompt was accepted; the run has one authoritative writer. */
  | { kind: 'started'; sessionId: string }
  /** The session exists but the single prompt did not land; no second send is attempted. */
  | { kind: 'prompt-undelivered'; sessionId: string; message: string }
  /** The host refused definitively. Nothing was started; the caller must not substitute a TUI. */
  | { kind: 'refused'; message: string }
  /** The outcome is not knowable from here. Never retried blind — a rival writer is the worse
   *  failure, and the host's durable record is what a later reconciliation reads. When the
   *  session is known, the persisted send operation names what a reconcile must replay. */
  | {
      kind: 'unconfirmed'
      message: string
      sessionId?: string
      /** The durable send envelope; replaying it is idempotent on the host. */
      pendingSend?: { clientOperationId: string; fence: number }
    }

/** Same-envelope replays after an unknown outcome, before the Start reports unconfirmed. */
const SEND_UNKNOWN_REPLAY_DELAYS_MS: readonly number[] = [250, 1_000]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const REFUSAL_REASONS: Record<string, string> = {
  agent: 'this agent has no structured session',
  remote: 'the workspace runs on a remote execution host',
  wsl: 'the workspace runs inside WSL'
}

function refusalMessage(reason: string): string {
  const explained = REFUSAL_REASONS[reason] ?? reason
  return `Work Item Start could not open a structured agent session: ${explained}. The workspace was created without an agent; no terminal writer was started in its place.`
}

/**
 * Starts the authoritative structured session for a Work Item Start and delivers its single
 * prompt.
 *
 * Why this exists at all: the task Start used to end at `worktree.create` with `startupAgent`,
 * which the host turns into a raw TUI terminal. A TUI pane carries no session identity, so
 * `worktree.ps` reports `agents: []` and anything reconciling the run sees no writer — the
 * identity has to come from the session record, never from the pane's title or process.
 *
 * Fail-closed on purpose: a refusal returns without launching anything, because falling back to a
 * terminal would re-create exactly the unidentifiable writer this replaces.
 */
export async function startWorkItemStructuredSession(args: {
  client: RpcClient
  worktreeId: string
  agent: TuiAgent
  prompt: string
}): Promise<WorkItemStartStructuredSessionResult> {
  const { client, worktreeId, agent, prompt } = args
  if (!isAgentSessionHandleProvider(agent)) {
    return { kind: 'refused', message: refusalMessage(`${agent} has no structured session`) }
  }
  const launch = await createMobileStructuredAgentSession(client, worktreeId, agent, {
    launchOrigin: 'work-item-start'
  })
  if (launch.kind === 'unsupported') {
    if (launch.probeFailed === true) {
      // The host never answered, so it never refused. Reporting this as a refusal would blame a
      // policy decision for what is a lost round trip.
      return {
        kind: 'unconfirmed',
        message:
          'Work Item Start could not reach this host to open the agent session. Open the workspace to check before starting it again.'
      }
    }
    return {
      kind: 'refused',
      message: refusalMessage(launch.reason ?? 'this host refused the structured session')
    }
  }
  if (launch.kind === 'failed') {
    return { kind: 'refused', message: refusalMessage(launch.message) }
  }
  if (launch.kind === 'unknown') {
    return { kind: 'unconfirmed', message: launch.message }
  }
  const body = structuredAgentSessionSendBody(prompt, [])
  if (body.blocks.length === 0) {
    return { kind: 'started', sessionId: launch.sessionId }
  }
  if (launch.fence === undefined) {
    // The send has to name the fence the create established. Guessing one is how a stale write
    // lands on a session that already moved on, so the prompt is reported, not invented.
    return {
      kind: 'prompt-undelivered',
      sessionId: launch.sessionId,
      message:
        'The session was created but this host did not return its fence, so the Work Item Start prompt was not sent.'
    }
  }
  return deliverWorkItemStartPrompt({
    client,
    worktreeId,
    sessionId: launch.sessionId,
    fence: launch.fence,
    body
  })
}

/**
 * Delivers the single Work Item Start prompt under one durable operation id.
 *
 * The envelope is persisted BEFORE the first dispatch: the host may commit the send and lose
 * only the reply, and a client that then mints a second id would put the prompt in provider
 * context twice. An unknown outcome (lost reply, `agent_session_operation_unknown`) replays the
 * exact same envelope — idempotent on the host — a bounded number of times, and what is still
 * unknown after that stays persisted for a later reconcile. Only a settled outcome clears it.
 */
export async function deliverWorkItemStartPrompt(args: {
  client: RpcClient
  worktreeId: string
  sessionId: string
  fence: number
  body: ReturnType<typeof structuredAgentSessionSendBody>
}): Promise<WorkItemStartStructuredSessionResult> {
  const { client, worktreeId, sessionId, fence, body } = args
  const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body }
  })
  const operationKey = mobileStructuredSendOperationKey({
    sessionKey: sessionId,
    intentFingerprint: payloadFingerprint
  })
  let persisted: Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>
  try {
    persisted = await getOrCreateMobileStructuredSendOperation({
      operationKey,
      callerIdentity: `work-item-start:${worktreeId}`,
      payloadFingerprint,
      attachmentPaths: [],
      createOperationId: structuredSessionOperationId
    })
  } catch (error) {
    // No durable record means no safe way to replay: the prompt is reported, not sent.
    return {
      kind: 'prompt-undelivered',
      sessionId,
      message: `The Work Item Start prompt was not sent: ${error instanceof Error ? error.message : 'its send operation could not be recorded'}.`
    }
  }
  const clientOperationId = persisted.operationId
  const pendingSend = { clientOperationId, fence }
  const settle = async (
    result: WorkItemStartStructuredSessionResult
  ): Promise<WorkItemStartStructuredSessionResult> => {
    await clearMobileStructuredSendOperation({
      operationKey,
      operationId: clientOperationId
    }).catch(() => undefined)
    return result
  }
  for (let attempt = 0; ; attempt += 1) {
    const delivery = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
      client,
      method: 'agentSession.send',
      fingerprintMethod: 'agentSession.send',
      sessionId,
      expectedRuntimeFence: fence,
      fields: { body },
      clientOperationId
    })
    if (delivery.status === 'unknown') {
      const replayDelayMs = SEND_UNKNOWN_REPLAY_DELAYS_MS[attempt]
      if (replayDelayMs === undefined) {
        return {
          kind: 'unconfirmed',
          sessionId,
          pendingSend,
          message:
            'The Work Item Start prompt could not be confirmed. Open the session before sending it again.'
        }
      }
      await delay(replayDelayMs)
      continue
    }
    return settleWorkItemStartDelivery(delivery, sessionId, pendingSend, settle)
  }
}

async function settleWorkItemStartDelivery(
  delivery: Exclude<
    Awaited<ReturnType<typeof requestStructuredAgentSessionMutation<AgentSessionSendResult>>>,
    { status: 'unknown' }
  >,
  sessionId: string,
  pendingSend: { clientOperationId: string; fence: number },
  settle: (
    result: WorkItemStartStructuredSessionResult
  ) => Promise<WorkItemStartStructuredSessionResult>
): Promise<WorkItemStartStructuredSessionResult> {
  const launch = { sessionId }
  if (delivery.status === 'accepted') {
    // `ok` is the mutation verdict, not the dispatch verdict: the host accepts the envelope and
    // then reports separately whether the provider actually took the turn.
    const dispatch = delivery.value?.submission?.dispatchState
    if (dispatch === 'accepted') {
      return settle({ kind: 'started', sessionId: launch.sessionId })
    }
    if (dispatch === 'rejected') {
      return settle({
        kind: 'prompt-undelivered',
        sessionId: launch.sessionId,
        message:
          delivery.value?.submission?.reason ??
          'The agent session rejected the Work Item Start prompt.'
      })
    }
    // `pending`/`unknown` dispatch: the host holds the envelope; the record stays until the
    // journal settles it.
    return {
      kind: 'unconfirmed',
      sessionId: launch.sessionId,
      pendingSend,
      message:
        'The Work Item Start prompt was submitted but not confirmed. Open the session before sending it again.'
    }
  }
  return settle({
    kind: 'prompt-undelivered',
    sessionId: launch.sessionId,
    message: delivery.message
  })
}
