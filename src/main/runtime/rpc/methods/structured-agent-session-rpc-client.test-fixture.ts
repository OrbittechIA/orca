import { vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

export const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}
export const STRUCTURED_MOBILE_CLIENT = {
  clientKind: 'mobile' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}

export function ordinaryStructuredSessionStoreFixture(sessionIds: readonly string[]) {
  const records = new Map(
    sessionIds.map(
      (sessionId) =>
        [sessionId, agentSessionRecordFixture({ sessionId, provider: 'codex' })] as const
    )
  )
  return {
    getOperationRow: vi.fn(() => null),
    getRecord: vi.fn((sessionId: string) => records.get(sessionId) ?? null),
    selectWritableRecord: vi.fn((sessionId: string) => {
      const record = records.get(sessionId)
      return record ? { kind: 'writable' as const, record } : { kind: 'missing' as const }
    }),
    listConversations: vi.fn(() => [...records.values()].map(agentSessionConversationView)),
    getConversation: vi.fn((sessionId: string) => {
      const record = records.get(sessionId)
      return record ? agentSessionConversationView(record) : null
    })
  }
}
