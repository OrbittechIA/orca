import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

const storage = vi.hoisted(() => ({ values: new Map<string, string>() }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.values.set(key, value)
    },
    removeItem: async (key: string) => {
      storage.values.delete(key)
    }
  }
}))
import { recordWorkItemStartAttempt } from './work-item-start-attempt-journal'
import {
  clearWorkItemStartSendIdentity,
  readWorkItemStartSendIdentity,
  recordWorkItemStartSendIdentity
} from './work-item-start-send-identity-journal'

// Frozen v1 reader from the .209 client: unknown fields reject the entire journal.
const LegacyJournal209 = z
  .object({
    v: z.literal(1),
    attempts: z.array(
      z
        .object({
          worktreeId: z.string().min(1).max(512),
          worktreeName: z.string().max(512),
          agent: z.enum(['claude', 'codex']),
          prompt: z.string().max(16_384),
          sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
          createClientOperationId: z.string().min(1).max(128)
        })
        .strict()
    )
  })
  .strict()
const ATTEMPT_KEY = 'orca:mobileWorkItemStartAttempts:v1'
const IDENTITY_KEY = 'orca:mobileWorkItemStartSendIdentities:v1'
function attempt(worktreeId: string, sessionId: string) {
  return {
    worktreeId,
    worktreeName: worktreeId,
    sessionId,
    agent: 'codex' as const,
    prompt: 'Synthetic prompt',
    createClientOperationId: `create-${sessionId}`
  }
}
beforeEach(() => {
  storage.values.clear()
})

it('keeps all persisted attempts readable by the strict .209 reader', async () => {
  const first = await recordWorkItemStartAttempt(attempt('workspace-one', 'session_one'))
  const second = await recordWorkItemStartAttempt(attempt('workspace-two', 'session_two'))
  const original = storage.values.get(ATTEMPT_KEY)
  await recordWorkItemStartSendIdentity(first, 'send-one')
  await recordWorkItemStartSendIdentity(second, 'send-two')
  expect(storage.values.get(ATTEMPT_KEY)).toBe(original)
  const legacy = LegacyJournal209.parse(JSON.parse(storage.values.get(ATTEMPT_KEY) ?? 'null'))
  expect(legacy.attempts).toEqual([first, second])
  expect(await readWorkItemStartSendIdentity(first)).toBe('send-one')
  expect(await readWorkItemStartSendIdentity(second)).toBe('send-two')
})

it('clears only the matching session and create operation in the sidecar', async () => {
  const old = attempt('workspace', 'session_old')
  const successor = attempt('workspace', 'session_new')
  const otherCreate = { ...old, createClientOperationId: 'other-create' }
  await recordWorkItemStartSendIdentity(old, 'send-old')
  await recordWorkItemStartSendIdentity(successor, 'send-successor')
  await recordWorkItemStartSendIdentity(otherCreate, 'send-other-create')
  await clearWorkItemStartSendIdentity(old)
  expect(await readWorkItemStartSendIdentity(old)).toBeUndefined()
  expect(await readWorkItemStartSendIdentity(successor)).toBe('send-successor')
  expect(await readWorkItemStartSendIdentity(otherCreate)).toBe('send-other-create')
})

it('refuses conflicting writes and corrupt sidecars without replacing held identities', async () => {
  const pending = attempt('workspace', 'session_pending')
  await recordWorkItemStartSendIdentity(pending, 'send-original')
  const original = storage.values.get(IDENTITY_KEY)
  await expect(recordWorkItemStartSendIdentity(pending, 'send-different')).rejects.toThrow(
    'identity changed'
  )
  expect(storage.values.get(IDENTITY_KEY)).toBe(original)
  storage.values.set(IDENTITY_KEY, '{broken')
  await expect(recordWorkItemStartSendIdentity(pending, 'send-different')).rejects.toThrow()
  expect(storage.values.get(IDENTITY_KEY)).toBe('{broken')
})
