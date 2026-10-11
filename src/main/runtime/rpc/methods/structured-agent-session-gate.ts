import type {
  StructuredAgentSessionLaunchOrigin,
  StructuredAgentSessionLaunchAuthority
} from '../../../../shared/structured-agent-session-create'
import type { StructuredAgentSessionCreateWorktreeTarget } from '../../structured-agent-session-create-worktree-target'
// Who may see `agentSession.*` at all.
//
// Shared by every structured method file so one gate governs the whole surface: a client that does
// not advertise `agent-session.structured.v1` is told the surface does not exist rather than being
// handed the session journal or mutation surface.
//
// This gate does not imply such a client cannot make the host exist: session-tab restore runs for
// old mobile clients so they receive a fallback row, and that path constructs the host.
// `agentSession.*` stays refused either way, which is what this gate is for.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { structuredAgentSessionHostRefusal } from '../../structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  clientReadsStructuredSessionAgent,
  isStructuredNativeChatEnabled,
  structuredWorkItemStartCallerAuthority,
  supportsStructuredAgentSessionCapability,
  supportsWorkItemStartStructuredSessionCreate,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (
    !supportsStructuredAgentSessionCapability(ctx) &&
    !structuredWorkItemStartCallerAuthority(ctx)
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function canAccessWorkItemStartStructuredSession(
  ctx: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  >,
  sessionId: string
): boolean {
  const callerAuthority = structuredWorkItemStartCallerAuthority(ctx)
  if (!callerAuthority) {
    return false
  }
  const record = getStructuredAgentSessionHost()?.deps?.store?.getRecord?.(sessionId)
  if (record?.launchOrigin !== 'work-item-start') {
    return false
  }
  if (callerAuthority.kind === 'local-desktop') {
    return true
  }
  return (
    record.launchAuthority?.kind === 'paired-device' &&
    record.launchAuthority.deviceId === callerAuthority.deviceId
  )
}

export async function resolveWorkItemStartStructuredCreateAuthority(
  ctx: RpcContext,
  worktree: string
): Promise<{
  launchAuthority: StructuredAgentSessionLaunchAuthority
  worktreeTarget: StructuredAgentSessionCreateWorktreeTarget
} | null> {
  const launchAuthority = structuredWorkItemStartCallerAuthority(ctx)
  if (!launchAuthority) {
    return null
  }
  // Resolved through the runtime's own folder-aware path, not `showManagedWorktree`: that
  // resolver knows repo-derived worktrees only, so it refused every folder-workspace Start.
  const worktreeTarget =
    await ctx.runtime.resolveStructuredAgentSessionCreateWorktreeTarget(worktree)
  if (
    launchAuthority.kind === 'paired-device' &&
    worktreeTarget.creatorDeviceId !== launchAuthority.deviceId
  ) {
    return null
  }
  return { launchAuthority, worktreeTarget }
}

export function isWorkItemStartStructuredSession(
  host: StructuredAgentSessionHost | null,
  sessionId: string
): boolean {
  // Defensive on purpose: an older host exposes no record store, and mixed versions are normal.
  // Without a store there is no scoped session, and throwing would break the whole surface.
  return host?.deps?.store?.getRecord?.(sessionId)?.launchOrigin === 'work-item-start'
}

export function canReachStructuredSession(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string
): boolean {
  return isWorkItemStartStructuredSession(host, sessionId)
    ? canAccessWorkItemStartStructuredSession(ctx, sessionId)
    : supportsStructuredSessions(ctx)
}

export function requireStructuredCreateHost(
  ctx: RpcContext,
  launchOrigin: StructuredAgentSessionLaunchOrigin | undefined,
  sessionId?: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const admitted = launchOrigin
    ? supportsWorkItemStartStructuredSessionCreate(ctx, launchOrigin) ||
      (sessionId !== undefined && canAccessWorkItemStartStructuredSession(ctx, sessionId))
    : supportsStructuredSessions(ctx)
  if (!admitted) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw (
      structuredAgentSessionHostRefusal() ??
      agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
    )
  }
  return host
}

export function requireWorkItemStartStatusHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = getStructuredAgentSessionHost()
  if (
    !structuredWorkItemStartCallerAuthority(ctx) ||
    !host ||
    (!supportsStructuredSessions(ctx) &&
      !(host.deps?.store?.listRecords?.() ?? []).some((record) =>
        canAccessWorkItemStartStructuredSession(ctx, record.sessionId)
      ))
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  return host
}

export function requireStructuredAgentAudience(ctx: RpcContext, agent: string): void {
  requireStructuredCapability(ctx)
  if (!clientReadsStructuredSessionAgent(ctx, agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/**
 * `agentSession.createSupport` alone also reads the host setting, for a client that leaves the
 * launch mode to the host; it gets the refusal it got before, which it reads as "open a terminal".
 */
export function requireStructuredCreateSupportAdmission(ctx: RpcContext, agent?: string): void {
  requireStructuredAgentAudience(ctx, agent ?? '')
  if (createSupportFollowsHostSetting(ctx) && !isStructuredNativeChatEnabled(ctx.runtime)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredHost(ctx: RpcContext, agent?: string): StructuredAgentSessionHost {
  requireStructuredAgentAudience(ctx, agent ?? '')
  if (!supportsStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  return requireHostOrRefusal()
}

export function requireStructuredSessionHost(
  ctx: RpcContext,
  sessionId: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = requireHostOrRefusal()
  if (!canReachStructuredSession(ctx, host, sessionId)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  requireStructuredAgentAudience(ctx, host.sessionAgent(sessionId) ?? '')
  return host
}

/**
 * The gate for methods that stop or retire work the caller already owns: close, cancel,
 * unsubscribe and release. It asks only what no caller can do without (the wire capability and a
 * host), never an admission condition: refusing a close strands a live provider child its own
 * owner can no longer shut down. It is `requireStructuredHost` today; keep it apart so a condition
 * added there for new work never reaches these.
 */
export function requireStructuredCleanupHost(
  ctx: RpcContext,
  sessionId?: string
): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  const admitted =
    host && sessionId && isWorkItemStartStructuredSession(host, sessionId)
      ? canAccessWorkItemStartStructuredSession(ctx, sessionId)
      : supportsStructuredAgentSessionCapability(ctx)
  if (!admitted) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  if (!host) {
    throw (
      structuredAgentSessionHostRefusal() ??
      agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
    )
  }
  return host
}

/**
 * The host, or why there is none. A process whose journal would not open says so under every
 * getter, close included: nothing here can stop a child it never started.
 */
function requireHostOrRefusal(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (host) {
    return host
  }
  throw (
    structuredAgentSessionHostRefusal() ??
    agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostDisabled' })
  )
}

/** Builds the host for a call that may be the first this process sees. Every session is addressed
 *  by its durable record — a read opens a conversation at rest — so each call that reaches for one
 *  may meet a host nothing has built yet. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  agentOrScope?:
    | string
    | {
        sessionId?: string
        launchOrigin?: StructuredAgentSessionLaunchOrigin
        /** Lists only the caller's own Work Item Start sessions, so Start authority suffices. */
        workItemStartOnly?: true
      }
): Promise<void> {
  const scoped = typeof agentOrScope === 'string' ? undefined : agentOrScope
  if (typeof agentOrScope === 'string') {
    requireStructuredAgentAudience(ctx, agentOrScope)
  }
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  const mayInstallForScopedSession =
    structuredWorkItemStartCallerAuthority(ctx) !== null &&
    (Boolean(scoped?.sessionId) ||
      scoped?.workItemStartOnly === true ||
      supportsWorkItemStartStructuredSessionCreate(ctx, scoped?.launchOrigin))
  if (!supportsStructuredSessions(ctx) && !mayInstallForScopedSession) {
    return
  }
  if (getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** The host for a read, built first when this process has none: the read RPCs share this one. */
export async function requireInstalledStructuredHost(
  ctx: RpcContext,
  sessionId?: string
): Promise<StructuredAgentSessionHost> {
  await ensureStructuredHostInstalled(ctx, sessionId ? { sessionId } : undefined)
  return sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireStructuredHost(ctx)
}

/** Mirrors the existing agent-session host-authority derivation so one client
 *  gets one operation namespace across both surfaces. */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey: ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
