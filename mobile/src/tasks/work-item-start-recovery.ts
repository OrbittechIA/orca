import { readLegacyWorkItemStartRecovery } from './work-item-start-legacy-recovery'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { CreateIntentParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import type { StructuredAgentSessionCreateParams } from '../../../src/shared/structured-agent-session-create'

const STORAGE_KEY = 'orca:mobileWorkItemStartCreates:v1'
const CreateJournal = z.object({
  v: z.literal(1),
  creates: z.array(z.object({
    worktreeId: z.string(),
    confirmed: z.boolean().optional(),
    params: CreateIntentParams
  }).strict()).max(64)
}).strict()
const writes = { tail: Promise.resolve() }

export type WorkItemStartRecovery =
  | { kind: 'none' }
  | { kind: 'create'; params: StructuredAgentSessionCreateParams }
  | { kind: 'legacy'; message: string }

export async function readWorkItemStartRecovery(worktreeId: string): Promise<WorkItemStartRecovery> {
  await writes.tail
  const legacy = await readLegacyWorkItemStartRecovery(AsyncStorage, worktreeId)
  if (legacy.kind === 'legacy') return legacy
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) return { kind: 'none' }
  const journal = CreateJournal.parse(JSON.parse(raw))
  const entry = journal.creates.find((candidate) => candidate.worktreeId === worktreeId)
  return entry && !entry.confirmed ? { kind: 'create', params: entry.params } : { kind: 'none' }
}

export function retainWorkItemStartCreate(worktreeId: string, params: StructuredAgentSessionCreateParams): Promise<void> {
  const run = writes.tail.then(async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    const journal = raw === null ? { v: 1 as const, creates: [] } : CreateJournal.parse(JSON.parse(raw))
    const existing = journal.creates.find((entry) => entry.worktreeId === worktreeId)
    if (existing) {
      if (JSON.stringify(existing.params) !== JSON.stringify(params)) {
        throw new Error('Work Item Start create identity changed. No prompt was sent.')
      }
      return
    }
    const next = CreateJournal.parse({ ...journal, creates: [...journal.creates, { worktreeId, params }] })
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  })
  writes.tail = run.catch(() => undefined)
  return run
}

export function confirmWorkItemStartCreate(worktreeId: string, sessionId: string): Promise<void> {
  const run = writes.tail.then(async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw === null) throw new Error('Work Item Start recovery data is missing.')
    const journal = CreateJournal.parse(JSON.parse(raw))
    const creates = journal.creates.map((entry) => entry.worktreeId === worktreeId &&
      entry.params.envelope.sessionId === sessionId ? { ...entry, confirmed: true } : entry)
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...journal, creates }))
  })
  writes.tail = run.catch(() => undefined)
  return run
}
