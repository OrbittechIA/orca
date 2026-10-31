import {
  boundOrchestrationFilesystemScopesEqual,
  isBoundOrchestrationFilesystemScope
} from '../../../../shared/orchestration-filesystem-scope'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { AgentSessionReserveRequest } from './agent-session-reservation-request'

/** A scope binds a fresh Codex thread; an adopted thread already ran under another policy. */
export function assertFilesystemScopeReservable(
  request: Pick<AgentSessionReserveRequest, 'filesystemScope' | 'provider' | 'adoptedHandleLink'>
): void {
  if (
    request.filesystemScope !== undefined &&
    (request.provider !== 'codex' ||
      request.adoptedHandleLink !== undefined ||
      !isBoundOrchestrationFilesystemScope(request.filesystemScope))
  ) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'identityMismatch' })
  }
}

/** A scope is never retrofitted onto, changed on, or removed from an existing record. */
export function assertFilesystemScopeUnchanged(
  record: Pick<AgentSessionRecord, 'filesystemScope'>,
  request: Pick<AgentSessionReserveRequest, 'filesystemScope'>
): void {
  if (
    request.filesystemScope !== undefined &&
    !boundOrchestrationFilesystemScopesEqual(record.filesystemScope, request.filesystemScope)
  ) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'identityMismatch' })
  }
}
