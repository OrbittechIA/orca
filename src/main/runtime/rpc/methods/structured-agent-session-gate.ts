// Require structured.v1 across every agentSession method before exposing journals or mutations.
// Legacy tab restore may still install the host for fallback rows; that never admits agentSession calls.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { RpcContext } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import {
  canReadStructuredSessionRecord,
  structuredSessionAdmissionRecord
} from './structured-agent-session-launch-authority'
export {
  structuredWorkItemStartCallerAuthority,
  canAccessWorkItemStartStructuredSession
} from './structured-agent-session-launch-authority'

import { structuredAgentSessionHostRefusal } from '../../structured-agent-session-host-refusal'
import {
  createSupportFollowsHostSetting,
  clientReadsStructuredSessionAgent,
  isStructuredNativeChatDefaultFor,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

export function canReachStructuredSession(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string
): boolean {
  return canReadStructuredSessionRecord(ctx, structuredSessionAdmissionRecord(host, sessionId))
}

export function requireStructuredSessionAdmission(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string
): void {
  if (!canReachStructuredSession(ctx, host, sessionId)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/** Only the store's authoritative answer proves absence; a null getRecord or an older store proves nothing. */
function selectStructuredSessionRecord(host: StructuredAgentSessionHost, sessionId: string) {
  return host.deps?.store?.selectWritableRecord?.(sessionId)
}

export function structuredSessionProvablyAbsent(
  host: StructuredAgentSessionHost,
  sessionId: string
): boolean {
  return selectStructuredSessionRecord(host, sessionId)?.kind === 'missing'
}

/** Only an authoritative missing record admits a fresh create; reservation still fences races. */
export function requireStructuredSessionCreateAdmission(
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string
): void {
  requireStructuredCapability(ctx)
  const selected = selectStructuredSessionRecord(host, sessionId)
  if (selected?.kind === 'missing') {
    return
  }
  if (selected?.kind === 'unreadable') {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
  requireStructuredSessionAdmission(ctx, host, sessionId)
}

/** In-process callers share the host build; remote callers must advertise structured-session support. */
export function supportsStructuredSessions(ctx: RpcContext): boolean {
  return supportsStructuredAgentSessions(ctx)
}

export function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredAgentAudience(ctx: RpcContext, agent: string): void {
  requireStructuredCapability(ctx)
  if (!clientReadsStructuredSessionAgent(ctx, agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

/** Only createSupport consults launch preference for legacy mode pickers, preserving their terminal-fallback refusal. */
export function requireStructuredCreateSupportAdmission(ctx: RpcContext, agent?: string): void {
  requireStructuredAgentAudience(ctx, agent ?? '')
  if (
    createSupportFollowsHostSetting(ctx) &&
    !isStructuredNativeChatDefaultFor(ctx.runtime, agent ?? '')
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'clientCapabilityMissing'
    })
  }
}

export function requireStructuredHost(ctx: RpcContext, agent?: string): StructuredAgentSessionHost {
  requireStructuredAgentAudience(ctx, agent ?? '')
  return requireHostOrRefusal()
}

export function requireStructuredSessionHost(
  ctx: RpcContext,
  sessionId: string
): StructuredAgentSessionHost {
  const host = requireStructuredHost(ctx)
  requireStructuredSessionAdmission(ctx, host, sessionId)
  requireStructuredAgentAudience(ctx, host.sessionAgent(sessionId) ?? '')
  return host
}

/** Close/cancel/unsubscribe/release check wire capability and host only; new-work admission conditions must never strand already-owned children. */
export function requireStructuredCleanupHost(
  ctx: RpcContext,
  sessionId?: string
): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = requireHostOrRefusal()
  if (sessionId) {
    requireStructuredSessionAdmission(ctx, host, sessionId)
  }
  return host
}

/** Return the host or its failure, including journal-open refusal; this process cannot stop children it never started. */
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

/** Build lazily before durable-record reads, including chats at rest after restart. */
export async function ensureStructuredHostInstalled(
  ctx: RpcContext,
  agent?: string
): Promise<void> {
  if (agent) {
    requireStructuredAgentAudience(ctx, agent)
  }
  // Check capability before observable host installation.
  if (!supportsStructuredSessions(ctx)) {
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
  await ensureStructuredHostInstalled(ctx)
  return sessionId ? requireStructuredSessionHost(ctx, sessionId) : requireStructuredHost(ctx)
}

/** Persist/share proven paired device id, never clientId bearer credentials (for example, who answered a prompt). */
export function structuredCallerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey:
      ctx.caller?.kind === 'paired-device'
        ? rpcCallerOperationKey(ctx.caller)
        : ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}
