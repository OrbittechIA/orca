import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import type { WorkItemStartAttempt } from './work-item-start-attempt-journal'

// Keep the attempt v1 bytes readable by older clients with a strict schema.
const STORAGE_KEY = 'orca:mobileWorkItemStartSendIdentities:v1'
const MAX_IDENTITIES = 64
const IdentitySchema = z
  .object({
    worktreeId: z.string().min(1).max(512),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    createClientOperationId: z.string().min(1).max(128),
    sendClientOperationId: z.string().min(1).max(128)
  })
  .strict()
const JournalSchema = z
  .object({
    v: z.literal(1),
    identities: z.array(IdentitySchema).max(MAX_IDENTITIES)
  })
  .strict()
type SendIdentity = z.infer<typeof IdentitySchema>
type AttemptIdentity = Pick<
  WorkItemStartAttempt,
  'worktreeId' | 'sessionId' | 'createClientOperationId'
>
const mutations: { tail: Promise<unknown> } = { tail: Promise.resolve() }

function matches(entry: SendIdentity, attempt: AttemptIdentity): boolean {
  return (
    entry.worktreeId === attempt.worktreeId &&
    entry.sessionId === attempt.sessionId &&
    entry.createClientOperationId === attempt.createClientOperationId
  )
}

async function readAll(): Promise<SendIdentity[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return []
  }
  const journal = JournalSchema.parse(JSON.parse(raw))
  const keys = journal.identities.map(({ worktreeId, sessionId, createClientOperationId }) =>
    JSON.stringify([worktreeId, sessionId, createClientOperationId])
  )
  if (new Set(keys).size !== keys.length) {
    throw new Error('Work Item Start send identities conflict')
  }
  return journal.identities
}

function mutate<T>(
  update: (entries: SendIdentity[]) => { next: SendIdentity[]; value: T }
): Promise<T> {
  const run = mutations.tail.then(async () => {
    const { next, value } = update(await readAll())
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, identities: next }))
    return value
  })
  mutations.tail = run.catch(() => undefined)
  return run
}

export async function readWorkItemStartSendIdentity(
  attempt: AttemptIdentity
): Promise<string | undefined> {
  await mutations.tail
  return (await readAll()).find((entry) => matches(entry, attempt))?.sendClientOperationId
}

export function recordWorkItemStartSendIdentity(
  attempt: AttemptIdentity,
  sendClientOperationId: string
): Promise<string> {
  return mutate((entries) => {
    const existing = entries.find((entry) => matches(entry, attempt))
    if (existing) {
      if (existing.sendClientOperationId !== sendClientOperationId) {
        throw new Error('Work Item Start send identity changed')
      }
      return { next: entries, value: existing.sendClientOperationId }
    }
    // Never evict an identity whose send might already be in provider context.
    if (entries.length >= MAX_IDENTITIES) {
      throw new Error('Work Item Start send identities are full')
    }
    const entry = IdentitySchema.parse({
      worktreeId: attempt.worktreeId,
      sessionId: attempt.sessionId,
      createClientOperationId: attempt.createClientOperationId,
      sendClientOperationId
    })
    return { next: [...entries, entry], value: sendClientOperationId }
  })
}

export function clearWorkItemStartSendIdentity(attempt: AttemptIdentity): Promise<void> {
  return mutate((entries) => ({
    next: entries.filter((entry) => !matches(entry, attempt)),
    value: undefined
  }))
}
