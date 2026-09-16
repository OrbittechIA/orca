import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { resolveWorkItemStartPromptDelivery } from '../../../src/shared/agent-session-options'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import { requestStructuredAgentSessionMutation } from '../session/mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc-client'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'

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

/**
 * Reads the host's admission once per Start. A probe that cannot answer returns `null`, which
 * `workItemStartHostAdmitsStructuredSession` reads as "not admitted" — the terminal Start this
 * client has always done, rather than a workspace with no writer at all.
 */
export async function readWorkItemStartHostAdmission(
  client: RpcClient
): Promise<WorkItemStartHostAdmission | null> {
  try {
    const response = await client.sendRequest('status.get')
    if (!response.ok || typeof response.result !== 'object' || response.result === null) {
      return null
    }
    const result = response.result as WorkItemStartHostAdmission
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
 * The one decision both Work Item Start entry points share: this host asked for
 * `submit-after-ready`, this pairing is admitted, and this agent is not `blank`.
 * The agent's own structured support is checked separately, because only once the host
 * admits the route does an unsupported agent become a refusal rather than a plain terminal Start.
 */
export async function workItemStartShouldUseStructuredSession(args: {
  client: RpcClient
  settings: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined
  agent: TuiAgent | 'blank' | undefined
}): Promise<boolean> {
  if (args.agent === undefined || args.agent === 'blank') {
    return false
  }
  if (!workItemStartRequiresStructuredSession(args.settings)) {
    return false
  }
  return workItemStartHostAdmitsStructuredSession(await readWorkItemStartHostAdmission(args.client))
}

export type WorkItemStartStructuredSessionResult =
  /** The session exists and the prompt was accepted; the run has one authoritative writer. */
  | { kind: 'started'; sessionId: string }
  /** The session exists but the single prompt did not land; no second send is attempted. */
  | { kind: 'prompt-undelivered'; sessionId: string; message: string }
  /** The host refused definitively. Nothing was started; the caller must not substitute a TUI. */
  | { kind: 'refused'; message: string }
  /** The outcome is not knowable from here. Never retried blind — a rival writer is the worse
   *  failure, and the host's durable record is what a later reconciliation reads. */
  | { kind: 'unconfirmed'; message: string }

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
  const delivery = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: launch.sessionId,
    expectedRuntimeFence: launch.fence,
    fields: { body }
  })
  if (delivery.status === 'accepted') {
    // `ok` is the mutation verdict, not the dispatch verdict: the host accepts the envelope and
    // then reports separately whether the provider actually took the turn.
    const dispatch = delivery.value?.submission?.dispatchState
    if (dispatch === 'accepted') {
      return { kind: 'started', sessionId: launch.sessionId }
    }
    if (dispatch === 'rejected') {
      return {
        kind: 'prompt-undelivered',
        sessionId: launch.sessionId,
        message:
          delivery.value?.submission?.reason ??
          'The agent session rejected the Work Item Start prompt.'
      }
    }
    return {
      kind: 'unconfirmed',
      message:
        'The Work Item Start prompt was submitted but not confirmed. Open the session before sending it again.'
    }
  }
  if (delivery.status === 'unknown') {
    return {
      kind: 'unconfirmed',
      message:
        'The Work Item Start prompt could not be confirmed. Open the session before sending it again.'
    }
  }
  return {
    kind: 'prompt-undelivered',
    sessionId: launch.sessionId,
    message: delivery.message
  }
}
