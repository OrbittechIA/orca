import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { parseAgentSessionOperationTimestamp } from '../../../src/shared/agent-session-host-authority'
import { structuredAgentSessionDomainFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import type { WorkItemStartSendBinding } from './work-item-start-send-identity-journal'

// Read-only migration of the reviewed v1 journal; new sends belong only to the Start sidecar.
const LEGACY_STORAGE_KEY = 'orca:mobileStructuredSendOperations:v1'
const LegacyJournalSchema = z
  .object({
    v: z.literal(1),
    entries: z
      .array(
        z
          .object({
            operationKey: z.string().regex(/^[0-9a-f]{64}$/),
            operationId: z.string().max(128),
            callerFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            attachmentPaths: z.array(z.string().max(4096)).max(128)
          })
          .strict()
      )
      .max(4096)
  })
  .strict()

export async function readLegacyWorkItemStartSendIdentity(
  binding: WorkItemStartSendBinding
): Promise<string | undefined> {
  const raw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY)
  if (raw === null) {
    return undefined
  }
  const journal = LegacyJournalSchema.parse(JSON.parse(raw))
  if (
    new Set(journal.entries.map((entry) => entry.operationKey)).size !== journal.entries.length ||
    journal.entries.some((entry) => parseAgentSessionOperationTimestamp(entry.operationId) === null)
  ) {
    throw new Error('The earlier Work Item Start send journal is unreadable')
  }
  const operationKey = structuredAgentSessionDomainFingerprint({
    domain: 'mobile.agentSession.send.operation',
    sessionId: binding.sessionId,
    fields: { intentFingerprint: binding.payloadFingerprint }
  })
  const held = journal.entries.find((entry) => entry.operationKey === operationKey)
  if (!held) {
    return undefined
  }
  if (
    held.callerFingerprint !== binding.callerFingerprint ||
    held.payloadFingerprint !== binding.payloadFingerprint ||
    held.attachmentPaths.length !== 0
  ) {
    throw new Error('The earlier Work Item Start send identity conflicts')
  }
  return held.operationId
}
