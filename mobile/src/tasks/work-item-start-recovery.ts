import { readLegacyWorkItemStartRecovery } from './work-item-start-legacy-recovery'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'
import { CreateIntentParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import type { StructuredAgentSessionCreateParams } from '../../../src/shared/structured-agent-session-create'
import {
  workItemStartCreateStorageKey,
  workItemStartAdmissionStorageKey
} from '../storage/work-item-start-storage-key'
import {
  PAGE_STORAGE_MAX_KEY_CHARS,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../mobile-web-shell/page-storage-keys'

const STORAGE_KEY = 'orca:mobileWorkItemStartCreates:v1'
const CreateEntry = z
  .object({
    worktreeId: z.string(),
    confirmed: z.boolean().optional(),
    params: CreateIntentParams
  })
  .strict()
const CreateJournal = z.object({ v: z.literal(1), creates: z.array(CreateEntry).max(64) }).strict()
const WorkspaceCreate = z.discriminatedUnion('confirmed', [
  z.object({ v: z.literal(1), confirmed: z.literal(false), params: CreateIntentParams }).strict(),
  z
    .object({
      v: z.literal(1),
      confirmed: z.literal(true),
      sessionId: z.string(),
      clientOperationId: z.string(),
      payloadFingerprint: z.string()
    })
    .strict()
])
const writes = { tail: Promise.resolve() }

export type WorkItemStartRecovery =
  | { kind: 'none' }
  | { kind: 'confirmed' }
  | { kind: 'create'; params: StructuredAgentSessionCreateParams }
  | { kind: 'legacy'; message: string }

function storageKey(hostId: string, worktreeId: string): string {
  if (!hostId) {
    throw new Error('Work Item Start requires a known host before creating a workspace.')
  }
  const key = workItemStartCreateStorageKey(hostId, worktreeId)
  if (key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
    throw new Error(
      'Work Item Start workspace identity exceeds the storage limit. No prompt was sent.'
    )
  }
  return key
}

function serialize(value: z.infer<typeof WorkspaceCreate>): string {
  const raw = JSON.stringify(WorkspaceCreate.parse(value))
  if (raw.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    throw new Error('Work Item Start exceeds the recovery storage limit. No prompt was sent.')
  }
  return raw
}

async function oldEntry(worktreeId: string) {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  return raw === null
    ? undefined
    : CreateJournal.parse(JSON.parse(raw)).creates.find((entry) => entry.worktreeId === worktreeId)
}

async function readRecovery(worktreeId: string, hostId: string): Promise<WorkItemStartRecovery> {
  const legacy = await readLegacyWorkItemStartRecovery(AsyncStorage, worktreeId)
  if (legacy.kind === 'legacy') {
    return legacy
  }
  const previous = await oldEntry(worktreeId)
  if (previous) {
    return previous.confirmed ? { kind: 'confirmed' } : { kind: 'create', params: previous.params }
  }
  const raw = await AsyncStorage.getItem(storageKey(hostId, worktreeId))
  if (raw === null) {
    return { kind: 'none' }
  }
  const entry = WorkspaceCreate.parse(JSON.parse(raw))
  return entry.confirmed ? { kind: 'confirmed' } : { kind: 'create', params: entry.params }
}

export async function readWorkItemStartRecovery(
  worktreeId: string,
  hostId: string
): Promise<WorkItemStartRecovery> {
  await writes.tail
  return readRecovery(worktreeId, hostId)
}

export async function admitWorkItemStartStorage(
  hostId: string,
  params: StructuredAgentSessionCreateParams
): Promise<void> {
  await writes.tail
  storageKey(hostId, '')
  // Any admissible workspace key fits this upper bound; reject oversized prompts before workspace effects.
  serialize({
    v: 1,
    confirmed: false,
    params: { ...params, worktree: `id:${'w'.repeat(PAGE_STORAGE_MAX_KEY_CHARS)}` }
  })
  await readLegacyWorkItemStartRecovery(AsyncStorage, '')
  await oldEntry('')
  const key = workItemStartAdmissionStorageKey(hostId)
  if (key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
    throw new Error('Work Item Start host identity exceeds the storage limit.')
  }
  await AsyncStorage.getItem(key)
  await AsyncStorage.setItem(key, '{"v":1}')
  if ((await AsyncStorage.getItem(key)) !== '{"v":1}') {
    throw new Error('Work Item Start storage could not be confirmed before workspace creation.')
  }
}

export function retainWorkItemStartCreate(
  worktreeId: string,
  hostId: string,
  params: StructuredAgentSessionCreateParams
): Promise<void> {
  const run = writes.tail.then(async () => {
    const recovery = await readRecovery(worktreeId, hostId)
    if (recovery.kind !== 'none') {
      throw new Error(
        'Work Item Start already has a saved identity. Review the existing conversation before sending anything.'
      )
    }
    const key = storageKey(hostId, worktreeId)
    const raw = serialize({ v: 1, confirmed: false, params })
    await AsyncStorage.setItem(key, raw)
    if ((await AsyncStorage.getItem(key)) !== raw) {
      throw new Error('Work Item Start recovery could not be saved. No prompt was sent.')
    }
  })
  writes.tail = run.catch(() => undefined)
  return run
}

export function confirmWorkItemStartCreate(
  worktreeId: string,
  hostId: string,
  sessionId: string
): Promise<void> {
  const run = writes.tail.then(async () => {
    const key = storageKey(hostId, worktreeId)
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      throw new Error('Work Item Start recovery data is missing.')
    }
    const entry = WorkspaceCreate.parse(JSON.parse(raw))
    if (entry.confirmed) {
      if (entry.sessionId === sessionId) {
        return
      }
      throw new Error('Work Item Start confirmation identity changed.')
    }
    if (entry.params.envelope.sessionId !== sessionId) {
      throw new Error('Work Item Start confirmation identity changed.')
    }
    const { clientOperationId, payloadFingerprint } = entry.params.envelope
    const tombstone = serialize({
      v: 1,
      confirmed: true,
      sessionId,
      clientOperationId,
      payloadFingerprint
    })
    await AsyncStorage.setItem(key, tombstone)
    if ((await AsyncStorage.getItem(key)) !== tombstone) {
      throw new Error('Work Item Start confirmation could not be saved.')
    }
  })
  writes.tail = run.catch(() => undefined)
  return run
}
