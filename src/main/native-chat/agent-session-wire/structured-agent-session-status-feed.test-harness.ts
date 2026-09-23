// Harness for the status feed suites: real journals on disk, a feed over an indexed session map,
// and one unfiltered subscriber whose events the suite reads.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'

export const SESSION = 'status-session'
export const TURN_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
} as const
export const USER_IDENTITY = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
} as const

let root: string
const journals = createTrackedJournalOpener()

/** Call once at suite level: every test gets a fresh journal root and closes what it opened. */
export function registerStatusFeedJournals(): void {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-'))
  })
  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
}

export async function openJournal(sessionId = SESSION, now?: () => number) {
  return journals.open({
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    now,
    journalDir: join(root, sessionId)
  })
}

export const indexed = indexedStatusFeedSession

export function feedFor(
  sessions: Map<
    string,
    { journal: Awaited<ReturnType<typeof openJournal>>; hasProviderChild?: boolean; fence?: number }
  >,
  record: Partial<AgentSessionRecord> | null = null,
  onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged'],
  readBackgroundTasks?: StructuredAgentSessionStatusFeedDeps['readBackgroundTasks'],
  statusSink?: StructuredAgentSessionStatusSink
) {
  let now = 1_000
  const feed = new StructuredAgentSessionStatusFeed({
    ...(onStatusChanged ? { onStatusChanged } : {}),
    ...(statusSink ? { statusSink: () => statusSink } : {}),
    ...(readBackgroundTasks ? { readBackgroundTasks } : {}),
    sessions: {
      get: (sessionId: string) => {
        const session = sessions.get(sessionId)
        return session ? indexed(session) : undefined
      },
      [Symbol.iterator]: function* () {
        for (const [sessionId, session] of sessions) {
          yield [sessionId, indexed(session)] as const
        }
      }
    } as unknown as ReadonlyMap<string, ReturnType<typeof indexed>>,
    getRecord: () => record as AgentSessionRecord | null,
    now: () => (now += 1)
  })
  const events: AgentSessionStatusEvent[] = []
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  return { feed, events, dispose }
}
