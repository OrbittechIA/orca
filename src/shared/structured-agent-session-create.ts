import { isUnknownRecord } from './unknown-record'
import type { AgentSessionHandleProvider } from './agent-session-provider-handle'
import type { AgentSessionMutationEnvelope } from './agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionCreateFingerprint
} from './structured-agent-session-mutation'

/**
 * The conversation a create adopts instead of starting a fresh one.
 *
 * Deliberately carries an identity and nothing else. The transcript file and the account home it
 * lives under are derived by the executing host, never sent: `agentSession.create` is reachable by
 * paired mobile clients, and a client-supplied path would let one choose which file the host reads
 * into a journal and which credential directory the provider child launches against.
 */
export type StructuredAgentSessionResumeSource = {
  /** claude: the session id. codex: the thread id. */
  providerSessionId: string
}

export type StructuredAgentSessionLaunchOrigin = 'work-item-start'

/** Host-derived authority retained with a scoped Work Item Start session. */
export type StructuredAgentSessionLaunchAuthority =
  | { kind: 'local-desktop' }
  | { kind: 'paired-device'; deviceId: string }

export function isStructuredAgentSessionLaunchAuthority(
  value: unknown
): value is StructuredAgentSessionLaunchAuthority {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!isUnknownRecord(value)) {
    return false
  }
  const authority = value
  return (
    authority.kind === 'local-desktop' ||
    (authority.kind === 'paired-device' &&
      typeof authority.deviceId === 'string' &&
      authority.deviceId.length > 0 &&
      authority.deviceId.length <= 512)
  )
}

export function structuredAgentSessionLaunchAuthoritiesEqual(
  left: StructuredAgentSessionLaunchAuthority | undefined,
  right: StructuredAgentSessionLaunchAuthority | undefined
): boolean {
  if (left?.kind !== right?.kind) {
    return false
  }
  return (
    left?.kind !== 'paired-device' ||
    (right?.kind === 'paired-device' && left.deviceId === right.deviceId)
  )
}

export type StructuredAgentSessionCreateParams = {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: AgentSessionHandleProvider
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Sent only to a host advertising `AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY`. */
  tabId?: string
  launchOrigin?: StructuredAgentSessionLaunchOrigin
}

/** Provider-prefixed so a session id names its lane on sight, and underscore-only
 *  so the id stays a single token everywhere it is embedded (tab ids, log keys). */
export function createStructuredAgentSessionId(
  agent: AgentSessionHandleProvider,
  randomUuid: () => string
): string {
  return `${agent}_${randomUuid().replaceAll('-', '_')}`
}

/** Whether a caller-minted id keeps the shape `createStructuredAgentSessionId` gives every id:
 *  named for its agent, then one token. The token alone is checked, so a hyphenated agent name
 *  is not refused at the wire. */
export function isStructuredAgentSessionIdFor(agent: string, sessionId: string): boolean {
  const prefix = `${agent}_`
  return sessionId.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(sessionId.slice(prefix.length))
}

/**
 * The durable `agentSession.create` envelope every client replays on an ambiguous
 * transport failure. The fingerprint must be computed over the same fields the host
 * recomputes, so both clients build it here rather than each assembling their own.
 */
export function structuredAgentSessionCreateParams(args: {
  sessionId: string
  worktree: string
  agent: AgentSessionHandleProvider
  resumeFrom?: StructuredAgentSessionResumeSource
  tabId?: string
  launchOrigin?: StructuredAgentSessionLaunchOrigin
  randomUuid: () => string
  now?: number
}): StructuredAgentSessionCreateParams {
  const fields = {
    worktree: args.worktree,
    agent: args.agent,
    ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
    ...(args.tabId ? { tabId: args.tabId } : {}),
    ...(args.launchOrigin ? { launchOrigin: args.launchOrigin } : {})
  }
  return {
    envelope: {
      sessionId: args.sessionId,
      clientOperationId: createStructuredAgentSessionOperationId(args.randomUuid, args.now),
      expectedRuntimeFence: null,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: args.sessionId,
        ...fields
      })
    },
    ...fields
  }
}
