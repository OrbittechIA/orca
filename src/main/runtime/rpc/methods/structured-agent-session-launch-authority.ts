import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  supportsStructuredAgentSessions,
  clientReadsStructuredSessionAgent
} from './structured-agent-session-audience'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { RpcContext } from '../core'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionLaunchAuthority } from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionLaunchAuthoritiesEqual } from '../../../../shared/structured-agent-session-launch-authority'

export function structuredWorkItemStartCallerAuthority(
  ctx: Pick<RpcContext, 'caller'>
): StructuredAgentSessionLaunchAuthority | null {
  if (ctx.caller?.kind === 'desktop') {
    return { kind: 'local-desktop' }
  }
  if (ctx.caller?.kind === 'paired-device' && ctx.caller.deviceId.trim()) {
    return { kind: 'paired-device', deviceId: ctx.caller.deviceId }
  }
  return null
}

export function canAccessWorkItemStartStructuredSession(
  ctx: Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>,
  sessionId: string,
  host: StructuredAgentSessionHost | null = getStructuredAgentSessionHost()
): boolean {
  const record = structuredSessionAdmissionRecord(host, sessionId)
  return (
    structuredSessionLaunchScope(record) === 'work-item-start' &&
    canReadStructuredSessionRecord(ctx, record)
  )
}

export function canReadStructuredSessionRecord(
  ctx: Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>,
  record:
    | Pick<AgentSessionRecord, 'provider' | 'launchOrigin' | 'launchAuthority'>
    | null
    | undefined
): boolean {
  const scope = structuredSessionLaunchScope(record)
  return (
    supportsStructuredAgentSessions(ctx) &&
    (scope === 'ordinary' ||
      (scope === 'work-item-start' &&
        clientReadsStructuredSessionAgent(ctx, record?.provider ?? '') &&
        canAccessWorkItemStartStructuredRecord(ctx, record)))
  )
}

export function structuredSessionAdmissionRecord(
  host: StructuredAgentSessionHost | null,
  sessionId: string
) {
  return (
    host?.deps?.store?.getRecord?.(sessionId) ??
    host?.deps?.store?.getConversation?.(sessionId) ??
    null
  )
}

export function structuredSessionTabVisibleToCaller(
  ctx: Pick<RpcContext, 'caller' | 'clientKind' | 'clientCapabilities'>,
  host: StructuredAgentSessionHost | null,
  sessionId: string
): boolean {
  const record = structuredSessionAdmissionRecord(host, sessionId)
  const scope = structuredSessionLaunchScope(record)
  return (
    scope === 'ordinary' ||
    (scope === 'work-item-start' &&
      host?.isSessionTabVisible(sessionId) === true &&
      canReadStructuredSessionRecord(ctx, record))
  )
}

export function structuredSessionLaunchScope(
  record: Pick<AgentSessionRecord, 'launchOrigin' | 'launchAuthority'> | null | undefined
): 'ordinary' | 'work-item-start' | 'unknown' {
  if (!record) {
    return 'unknown'
  }
  if (record.launchOrigin === 'work-item-start') {
    return 'work-item-start'
  }
  return record.launchOrigin === undefined && record.launchAuthority === undefined
    ? 'ordinary'
    : 'unknown'
}

export function canAccessWorkItemStartStructuredRecord(
  ctx: Pick<RpcContext, 'caller'>,
  record: Pick<AgentSessionRecord, 'launchOrigin' | 'launchAuthority'> | null | undefined
): boolean {
  return (
    record?.launchOrigin === 'work-item-start' &&
    structuredAgentSessionLaunchAuthoritiesEqual(
      record.launchAuthority,
      structuredWorkItemStartCallerAuthority(ctx) ?? undefined
    )
  )
}
