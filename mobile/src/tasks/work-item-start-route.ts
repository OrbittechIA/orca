import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { resolveWorkItemStartPromptDelivery } from '../../../src/shared/agent-session-options'
import { workItemStartExecutionHostRefusal } from '../../../src/shared/work-item-start-execution-host'
import { STRUCTURED_SUPPORT_PROBE_TIMEOUT_MS } from '../session/mobile-structured-agent-session-launch'
import { structuredAgentSupportProbe } from '../session/mobile-session-launch-operations'
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
  scope:
    'Work Item Start is set to submit after ready, but this phone is paired with mobile scope, and the host admits the structured session only for runtime-scoped clients. Nothing was created; no terminal was started in its place. Start this work item from the desktop, or set Work Item Start back to draft.',
  unknown:
    'Work Item Start is set to submit after ready, but this host did not answer whether it admits the structured session. Nothing was created. Check the connection and try again.',
  remote:
    'Work Item Start is set to submit after ready, but this repository runs on a remote execution host, where the structured session is not supported. Nothing was created; no terminal was started in its place.',
  wsl: 'Work Item Start is set to submit after ready, but this repository runs inside WSL, where the structured session is not supported. Nothing was created; no terminal was started in its place.',
  agent:
    'Work Item Start is set to submit after ready, but the selected agent or its active account is not eligible for a structured session on this host. Nothing was created; no terminal was started in its place.',
  repoRefused:
    'Work Item Start is set to submit after ready, but this host could not confirm this repository can run the structured session (an older host, or a project runtime that needs repair). Nothing was created; no terminal was started in its place.',
  repoUnknown:
    'Work Item Start is set to submit after ready, but this host did not answer whether this repository can run the structured session. Nothing was created. Check the connection and try again.'
} as const

/** The repo row the workspace would be created from; its execution host is checked pre-create. */
export type WorkItemStartRepo = {
  id: string
  path: string
  connectionId?: string | null
  executionHostId?: string | null
}

/**
 * The host's create-support verdict for the repo, asked BEFORE `worktree.create`. Only the host
 * knows the runtime the workspace will run in: a `C:\` repo whose project is set to WSL looks
 * native from here. A host without the repo probe rejects its params, which refuses the Start.
 */
async function resolveWorkItemStartRepoSupport(
  client: RpcClient,
  repo: WorkItemStartRepo,
  agent: 'claude' | 'codex'
): Promise<WorkItemStartRoute> {
  let reply
  try {
    reply = await structuredAgentSupportProbe.request(
      client,
      { repo: `id:${repo.id}`, agent, launchOrigin: 'work-item-start' },
      { timeoutMs: STRUCTURED_SUPPORT_PROBE_TIMEOUT_MS }
    )
  } catch {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.repoUnknown }
  }
  if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.repoUnknown }
  }
  if (!reply.ok) {
    return { kind: 'refused', message: WORK_ITEM_START_ROUTE_MESSAGES.repoRefused }
  }
  const result: unknown = reply.result
  if (!result || typeof result !== 'object' || !('supported' in result)) {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.repoUnknown }
  }
  if (result.supported === true) {
    return { kind: 'structured' }
  }
  if (result.supported !== false) {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.repoUnknown }
  }
  const reason = 'reason' in result ? result.reason : undefined
  return {
    kind: 'refused',
    message:
      reason === 'remote' || reason === 'wsl' || reason === 'agent'
        ? WORK_ITEM_START_ROUTE_MESSAGES[reason]
        : WORK_ITEM_START_ROUTE_MESSAGES.repoRefused
  }
}

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
  repo: WorkItemStartRepo
}): Promise<WorkItemStartRoute> {
  if (args.agent === undefined || args.agent === 'blank') {
    return { kind: 'terminal' }
  }
  if (!workItemStartRequiresStructuredSession(args.settings)) {
    return { kind: 'terminal' }
  }
  // Same verdict desktop reaches pre-create; the host would only refuse after the workspace exists.
  const hostRefusal = workItemStartExecutionHostRefusal(args.repo)
  if (hostRefusal) {
    return { kind: 'refused', message: WORK_ITEM_START_ROUTE_MESSAGES[hostRefusal] }
  }
  const admission = await readWorkItemStartHostAdmission(args.client)
  if (admission === null) {
    return { kind: 'unknown', message: WORK_ITEM_START_ROUTE_MESSAGES.unknown }
  }
  if (!workItemStartHostAdmitsStructuredSession(admission)) {
    // The host named this pairing's scope: that refusal holds on any build, so it is not blamed on age.
    const scopeRefused = admission.deviceScope !== undefined && admission.deviceScope !== 'runtime'
    return {
      kind: 'refused',
      message: WORK_ITEM_START_ROUTE_MESSAGES[scopeRefused ? 'scope' : 'refused']
    }
  }
  // An agent without a structured session is refused by the callers, never probed.
  return isAgentSessionHandleProvider(args.agent)
    ? resolveWorkItemStartRepoSupport(args.client, args.repo, args.agent)
    : { kind: 'structured' }
}

/** Kept for callers that only need the admitted case; a strict Start must read the route. */
export async function workItemStartShouldUseStructuredSession(
  args: Parameters<typeof resolveWorkItemStartRoute>[0]
): Promise<boolean> {
  return (await resolveWorkItemStartRoute(args)).kind === 'structured'
}
