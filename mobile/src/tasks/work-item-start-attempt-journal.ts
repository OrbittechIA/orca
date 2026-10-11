import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'

/**
 * A strict Work Item Start that created its workspace but has not confirmed its session.
 *
 * Written right after `worktree.create` and BEFORE the session is requested, so every retry for the
 * workspace re-enters with the SAME session id and create operation: the host replays a create it
 * already committed instead of admitting a second session, and the send journal (keyed by session
 * id) replays the same prompt operation. Cleared only once the Start settles.
 */
export type WorkItemStartAttempt = {
  worktreeId: string
  worktreeName: string
  agent: 'claude' | 'codex'
  prompt: string
  sessionId: string
  createClientOperationId: string
}

const STORAGE_KEY = 'orca:mobileWorkItemStartAttempts:v1'
// Bounded: an attempt belongs to one workspace, and a phone never has many unsettled Starts.
const MAX_ATTEMPTS = 64

const AttemptSchema = z
  .object({
    worktreeId: z.string().min(1).max(512),
    worktreeName: z.string().max(512),
    agent: z.enum(['claude', 'codex']),
    prompt: z.string().max(16_384),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    createClientOperationId: z.string().min(1).max(128)
  })
  .strict()
const JournalSchema = z.object({ v: z.literal(1), attempts: z.array(AttemptSchema) }).strict()

const mutations: { tail: Promise<unknown> } = { tail: Promise.resolve() }

async function readAll(): Promise<WorkItemStartAttempt[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.attempts : []
  } catch {
    return []
  }
}

/** Serialized so a read-modify-write never drops a concurrent attempt. */
function mutate<T>(
  update: (attempts: WorkItemStartAttempt[]) => { next: WorkItemStartAttempt[]; value: T }
): Promise<T> {
  const run = mutations.tail.then(async () => {
    const { next, value } = update(await readAll())
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, attempts: next.slice(-MAX_ATTEMPTS) })
    )
    return value
  })
  mutations.tail = run.catch(() => undefined)
  return run
}

export async function readWorkItemStartAttempt(
  worktreeId: string
): Promise<WorkItemStartAttempt | null> {
  await mutations.tail
  return (await readAll()).find((attempt) => attempt.worktreeId === worktreeId) ?? null
}

/** Returns the attempt already recorded for this workspace, so its identity is never re-minted. */
export function recordWorkItemStartAttempt(
  attempt: WorkItemStartAttempt
): Promise<WorkItemStartAttempt> {
  return mutate((attempts) => {
    const existing = attempts.find((entry) => entry.worktreeId === attempt.worktreeId)
    return existing
      ? { next: attempts, value: existing }
      : { next: [...attempts, attempt], value: attempt }
  })
}

export function clearWorkItemStartAttempt(worktreeId: string, sessionId: string): Promise<void> {
  return mutate((attempts) => ({
    next: attempts.filter(
      (entry) => !(entry.worktreeId === worktreeId && entry.sessionId === sessionId)
    ),
    value: undefined
  }))
}

export async function resetWorkItemStartAttemptJournalForTests(): Promise<void> {
  await mutations.tail
  await AsyncStorage.removeItem(STORAGE_KEY)
}
