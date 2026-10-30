import { describe, expect, it } from 'vitest'
import { readLegacyWorkItemStartRecovery } from './work-item-start-legacy-recovery'

const key = 'orca:mobileWorkItemStartAttempts:v1'
const sidecar = 'orca:mobileWorkItemStartSendIdentities:v1'

describe('224 Work Item Start recovery', () => {
  it.each([key, sidecar])(
    'retains %s without minting, clearing or converting it to a first message',
    async (journalKey) => {
      const entry = {
        worktreeId: 'repo::/work',
        sessionId: 'codex_held',
        createClientOperationId: 'create-held',
        sendClientOperationId: 'send-held'
      }
      const raw = JSON.stringify({
        v: 1,
        [journalKey === key ? 'attempts' : 'identities']: [entry]
      })
      const store = new Map([
        [journalKey, raw],
        ['orca:mobileStructuredSendOperations:v1', 'opaque legacy journal']
      ])
      expect(
        await readLegacyWorkItemStartRecovery(
          { getItem: async (name) => store.get(name) ?? null },
          entry.worktreeId
        )
      ).toMatchObject({ kind: 'legacy' })
      expect(store.get(journalKey)).toBe(raw)
      expect(store.get('orca:mobileStructuredSendOperations:v1')).toBe('opaque legacy journal')
    }
  )
  it.each(['{', '{}', '{"v":2,"attempts":[]}', '{"v":1,"attempts":[{}]}'])(
    'fails closed on unreadable recovery data %s',
    async (raw) => {
      await expect(
        readLegacyWorkItemStartRecovery({ getItem: async () => raw }, 'work')
      ).rejects.toThrow()
    }
  )
})
