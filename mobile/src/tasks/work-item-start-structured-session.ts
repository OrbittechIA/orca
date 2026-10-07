import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-outbox'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import { createStructuredAgentSessionId } from '../../../src/shared/structured-agent-session-create'
import {
  clearWorkItemStartAttempt,
  readWorkItemStartAttempt,
  recordWorkItemStartAttempt
} from './work-item-start-attempt-journal'
import {
  structuredSessionOperationId,
  structuredSessionRandomUuid
} from '../session/structured-session-operation-id'
import type { RpcClient } from '../transport/rpc-client'
import { deliverWorkItemStartPrompt } from './work-item-start-prompt-delivery'

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

const REFUSAL_REASONS: Record<string, string> = {
  agent: 'the selected agent or its active account is not eligible for a structured session',
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
  worktreeName?: string
  agent: TuiAgent
  prompt: string
}): Promise<WorkItemStartStructuredSessionResult> {
  if (!isAgentSessionHandleProvider(args.agent)) {
    return { kind: 'refused', message: refusalMessage(`${args.agent} has no structured session`) }
  }
  const agent = args.agent
  for (;;) {
    // A joined Retry that found nothing recorded yields null; this Start then runs its own flight.
    const result = await joinWorkItemStartFlight(args.worktreeId, () =>
      runWorkItemStartStructuredSession({ ...args, agent })
    )
    if (result) {
      return result
    }
  }
}

/**
 * Re-enters a strict Start whose workspace exists but whose session was never confirmed. Returns
 * `null` when nothing is pending for this workspace; it never calls `worktree.create`.
 */
export function retryWorkItemStartStructuredSession(args: {
  client: RpcClient
  worktreeId: string
}): Promise<WorkItemStartStructuredSessionResult | null> {
  return joinWorkItemStartFlight(args.worktreeId, async () => {
    // Read inside the flight: a Retry queued behind a settled Start must see the cleared record.
    const attempt = await readWorkItemStartAttempt(args.worktreeId)
    if (!attempt) {
      return null
    }
    return runWorkItemStartStructuredSession({
      client: args.client,
      worktreeId: attempt.worktreeId,
      worktreeName: attempt.worktreeName,
      agent: attempt.agent,
      prompt: attempt.prompt
    })
  })
}

/**
 * One Start or Retry per workspace at a time. The journals make a *sequential* re-entry replay
 * the same session and send, but two overlapping flows interleave around them: the first clears
 * the send record on settle and the second mints a new one, delivering the prompt twice.
 */
const workItemStartFlights = new Map<string, Promise<WorkItemStartStructuredSessionResult | null>>()

function joinWorkItemStartFlight(
  worktreeId: string,
  run: () => Promise<WorkItemStartStructuredSessionResult | null>
): Promise<WorkItemStartStructuredSessionResult | null> {
  const existing = workItemStartFlights.get(worktreeId)
  if (existing) {
    return existing
  }
  const flight = run()
  workItemStartFlights.set(worktreeId, flight)
  // Registered before any caller awaits, so the slot is free by the time a caller sees the result.
  const release = (): void => {
    if (workItemStartFlights.get(worktreeId) === flight) {
      workItemStartFlights.delete(worktreeId)
    }
  }
  flight.then(release, release)
  return flight
}

async function runWorkItemStartStructuredSession(args: {
  client: RpcClient
  worktreeId: string
  worktreeName?: string
  agent: 'claude' | 'codex'
  prompt: string
}): Promise<WorkItemStartStructuredSessionResult> {
  const { client, worktreeId, agent } = args
  let attempt
  try {
    // An attempt already recorded for this workspace wins: its identity, agent and prompt are the
    // ones the host may already hold, so a retry can never mint a second session.
    attempt = await recordWorkItemStartAttempt({
      worktreeId,
      worktreeName: args.worktreeName ?? '',
      agent,
      prompt: args.prompt,
      sessionId: createStructuredAgentSessionId(agent, structuredSessionRandomUuid),
      createClientOperationId: structuredSessionOperationId()
    })
  } catch (error) {
    // Without a durable identity a lost reply could not be reconciled, so nothing is requested.
    return {
      kind: 'unconfirmed',
      message: `Work Item Start could not record its session before opening it: ${error instanceof Error ? error.message : 'storage unavailable'}. Nothing was started.`
    }
  }
  const result = await openWorkItemStartSession(
    client,
    attempt.agent,
    attempt.worktreeId,
    {
      sessionId: attempt.sessionId,
      createClientOperationId: attempt.createClientOperationId
    },
    attempt.prompt
  )
  // Settled outcomes release the identity; an unconfirmed one keeps it for the retry.
  if (result.kind !== 'unconfirmed') {
    await clearWorkItemStartAttempt(attempt.worktreeId, attempt.sessionId).catch(() => undefined)
  }
  return result
}

async function openWorkItemStartSession(
  client: RpcClient,
  agent: 'claude' | 'codex',
  worktreeId: string,
  identity: { sessionId: string; createClientOperationId: string },
  prompt: string
): Promise<WorkItemStartStructuredSessionResult> {
  const launch = await createMobileStructuredAgentSession(client, worktreeId, agent, {
    launchOrigin: 'work-item-start',
    identity
  })
  if (launch.kind === 'unsupported') {
    if (launch.probeFailed === true) {
      // The host never answered, so it never refused. Reporting this as a refusal would blame a
      // policy decision for what is a lost round trip.
      return {
        kind: 'unconfirmed',
        sessionId: identity.sessionId,
        message:
          'Work Item Start could not reach this host to open the agent session. Retry Start on the workspace to reconcile the same session.'
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
    return { kind: 'unconfirmed', sessionId: identity.sessionId, message: launch.message }
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
