// The status feed half of the `agentSession.*` dispatcher harness: one REAL feed per test,
// shared by every `agentSession.subscribeStatus` the test opens, over a journal the test can
// advance. That is what lets a suite prove which later status events reach which subscriber.

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import { StructuredAgentSessionStatusFeed } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'

export const STATUS_SESSION = 'session-status'
export const STATUS_ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: 'user-1',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] }
  },
  {
    itemId: 'turn-1',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    body: { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  }
]

/** The status journal is mutable so a suite can drive a publication AFTER a stream is open:
 *  that is the only way to prove what a later status event does or does not reach. */
let statusJournalState = { sequence: 2, items: STATUS_ITEMS }
let sharedStatusFeed: StructuredAgentSessionStatusFeed | null = null

/** One indexed session over a journal that reads back the current items; the projection is real. */
function statusFeed(): StructuredAgentSessionStatusFeed {
  return new StructuredAgentSessionStatusFeed({
    sessions: new Map([
      [
        STATUS_SESSION,
        {
          journal: {
            isReadOnly: false,
            cursor: () => ({ epoch: 'epoch-status', sequence: statusJournalState.sequence }),
            lastActivityAt: () => statusJournalState.sequence,
            snapshot: () => ({ items: statusJournalState.items })
          } as unknown as AgentSessionJournal,
          params: { location: { workspaceId: 'workspace-1' }, provider: 'codex' as const }
        }
      ]
    ]),
    getRecord: () => null,
    now: () => 1_000
  })
}

/** A fresh feed and journal per test; `hostStub()` calls this. */
export function resetStatusFeed(): void {
  statusJournalState = { sequence: 2, items: STATUS_ITEMS }
  sharedStatusFeed = statusFeed()
}

/** The feed every `agentSession.subscribeStatus` of the current test shares. */
export function statusFeedInstance(): StructuredAgentSessionStatusFeed {
  if (!sharedStatusFeed) {
    throw new Error('installStructuredHostStub() first')
  }
  return sharedStatusFeed
}

/** Advance the status journal and re-project it, as a host does after a journal edge. */
export function publishStatusItems(items: AgentJournalRenderItem[]): void {
  statusJournalState = { sequence: statusJournalState.sequence + 1, items }
  statusFeedInstance().publish(STATUS_SESSION)
}
