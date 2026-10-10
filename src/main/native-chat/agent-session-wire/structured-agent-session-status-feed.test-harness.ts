import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { indexedStatusFeedSession as indexed } from './structured-agent-session-status-feed-test-session'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedDeps,
  type StructuredAgentSessionStatusSink
} from './structured-agent-session-status-feed'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-status-feed-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

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
    stateDirectory: join(root, sessionId)
  })
}

export function feedFor(
  sessions: Map<string, Parameters<typeof indexed>[0]>,
  record: Partial<AgentSessionRecord> | null = null,
  onStatusChanged?: StructuredAgentSessionStatusFeedDeps['onStatusChanged'],
  readChildWork?: () => AgentChildWorkView[],
  statusSink?: StructuredAgentSessionStatusSink
) {
  let now = 1_000
  // The summary reads child records where the host keeps them: the sink its row landed in.
  const sink =
    statusSink ??
    (readChildWork ? { publish: () => {}, forget: () => {}, readChildWork } : undefined)
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    ...(onStatusChanged ? { onStatusChanged } : {}),
    ...(sink ? { statusSink: () => sink } : {}),
    sessions: new Map([...sessions].map(([sessionId, session]) => [sessionId, indexed(session)])),
    // A partial record still has a lease: the feed reads the conversation's fence off it.
    getRecord: () => (record ? { ...agentSessionRecordFixture(), ...record } : null),
    now: () => (now += 1)
  })
  const events: AgentSessionStatusEvent[] = []
  const dispose = feed.subscribe({ id: 'list-1', emit: (event) => events.push(event) })
  return { feed, events, dispose }
}
