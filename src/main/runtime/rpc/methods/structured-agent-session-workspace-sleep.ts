import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { defineMethod } from '../core'
import {
  canReachStructuredSession,
  requireStructuredCapability,
  requireInstalledStructuredHost as requireInstalledHost
} from './structured-agent-session-gate'
import { canReadStructuredSessionRecord } from './structured-agent-session-launch-authority'
import { SleepWorkspaceParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_WORKSPACE_SLEEP_METHODS = [
  defineMethod({
    name: 'agentSession.sleepWorkspace',
    permission: 'workspace',
    params: SleepWorkspaceParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      const sleep = (host: StructuredAgentSessionHost) =>
        host.sleepWorkspace(params.workspaceId, params.markAsleep, (sessionId) =>
          canReachStructuredSession(ctx, host, sessionId)
        )
      if (params.markAsleep) {
        const host = await requireInstalledHost(ctx)
        return sleep(host)
      }
      const installed = getStructuredAgentSessionHost()
      if (installed) {
        return sleep(installed)
      }
      let store: Awaited<ReturnType<typeof ctx.runtime.openAgentSessionRecordStore>>
      try {
        store = await ctx.runtime.openAgentSessionRecordStore()
      } catch (error) {
        const appeared = getStructuredAgentSessionHost()
        if (appeared) {
          return sleep(appeared)
        }
        console.warn('[agent-session] workspace sleep record inventory unavailable', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
      const appeared = getStructuredAgentSessionHost()
      if (appeared) {
        return sleep(appeared)
      }
      try {
        const records = store
          .listConversations()
          .filter(
            (record) =>
              record.location.workspaceId === params.workspaceId &&
              record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
          )
        if (records.some((record) => !canReadStructuredSessionRecord(ctx, record))) {
          throw agentSessionRefusalError('structured_agent_session_unsupported', {
            reason: 'clientCapabilityMissing'
          })
        }
        const stoppedSessionIds = records
          .filter((record) => record.neverStarted)
          .map((record) => record.sessionId)
        const failures = records
          .filter((record) => !record.neverStarted)
          .map((record) => ({ sessionId: record.sessionId, reason: 'stop-unverifiable' as const }))
        return failures.length > 0 ? { stoppedSessionIds, failures } : { stoppedSessionIds }
      } catch (error) {
        console.warn('[agent-session] workspace sleep record inventory failed', error)
        return { stoppedSessionIds: [], failures: [{ reason: 'inventory-unavailable' }] }
      }
    }
  })
]
