// Per-subscriber scope on the status feed. A Work Item Start session created by one paired
// runtime must be invisible to every other paired runtime on every event that names a session,
// not only on the opening snapshot; `end` names none and always arrives.

import { describe, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import {
  feedFor,
  openJournal,
  registerStatusFeedJournals,
  SESSION,
  USER_IDENTITY
} from './structured-agent-session-status-feed.test-harness'

registerStatusFeedJournals()

describe('StructuredAgentSessionStatusFeed subscriber scope', () => {
  it('never leaks a scoped session to a subscriber that cannot access it', async () => {
    const DENIED = SESSION
    const ALLOWED = 'allowed-session'
    const denied = await openJournal(DENIED)
    const allowed = await openJournal(ALLOWED)
    const sessions = new Map([
      [DENIED, { journal: denied, hasProviderChild: true }],
      [ALLOWED, { journal: allowed }]
    ])
    const { feed, events: unscoped } = feedFor(sessions)
    const scoped: AgentSessionStatusEvent[] = []
    const dispose = feed.subscribe(
      { id: 'paired-other', emit: (event) => scoped.push(event) },
      (sessionId) => sessionId === ALLOWED
    )
    // The opening snapshot already hides the denied session.
    expect(scoped).toEqual([
      { type: 'snapshot', sessions: [expect.objectContaining({ sessionId: ALLOWED })] }
    ])

    // A later publish names its session at `event.session`, which is where the leak was.
    await denied.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'secret prompt' }] },
      { fence: 1 }
    )
    feed.publish(DENIED)
    feed.revokeLive(DENIED)
    expect(unscoped.filter((event) => event.type === 'status')).toHaveLength(2)
    expect(scoped).toHaveLength(1)
    expect(JSON.stringify(scoped)).not.toContain('secret prompt')

    // The allowed session still flows.
    await allowed.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'visible prompt' }] },
      { fence: 1 }
    )
    feed.publish(ALLOWED)
    expect(scoped.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: ALLOWED, latestPrompt: 'visible prompt' })
    })

    // `end` carries no session and always reaches the subscriber; nothing follows it.
    dispose()
    expect(scoped.at(-1)).toEqual({ type: 'end' })
    feed.publish(DENIED)
    feed.publish(ALLOWED)
    expect(scoped.at(-1)).toEqual({ type: 'end' })
    expect(scoped.filter((event) => event.type === 'end')).toHaveLength(1)
  })

  it('emits an empty snapshot, not none, when every session is out of scope', async () => {
    const journal = await openJournal()
    const { feed } = feedFor(new Map([[SESSION, { journal }]]))
    const scoped: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'paired-other', emit: (event) => scoped.push(event) }, () => false)
    expect(scoped).toEqual([{ type: 'snapshot', sessions: [] }])
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION)
    feed.revokeLive(SESSION)
    expect(scoped).toHaveLength(1)
  })

  it('drops the scope filter with its subscriber on direct unsubscribe and on emit failure', async () => {
    const journal = await openJournal()
    const { feed } = feedFor(new Map([[SESSION, { journal }]]))

    // Direct `unsubscribe(id)`, not the disposer: the filter must not outlive the subscriber,
    // or a later unfiltered subscribe under the same id would inherit a scope it never asked for.
    const first: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'reused', emit: (event) => first.push(event) }, () => false)
    feed.unsubscribe('reused')
    expect(first).toEqual([{ type: 'snapshot', sessions: [] }, { type: 'end' }])
    const second: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'reused', emit: (event) => second.push(event) })
    expect(second).toEqual([
      { type: 'snapshot', sessions: [expect.objectContaining({ sessionId: SESSION })] }
    ])
    feed.unsubscribe('reused')

    // A transport that throws is dropped together with its filter.
    let calls = 0
    feed.subscribe(
      {
        id: 'reused',
        emit: () => {
          calls += 1
          throw new Error('transport gone')
        }
      },
      () => false
    )
    expect(calls).toBe(1)
    const third: AgentSessionStatusEvent[] = []
    feed.subscribe({ id: 'reused', emit: (event) => third.push(event) })
    expect(third).toEqual([
      { type: 'snapshot', sessions: [expect.objectContaining({ sessionId: SESSION })] }
    ])
    await journal.appendItem(
      USER_IDENTITY,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { fence: 1 }
    )
    feed.publish(SESSION)
    expect(third.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, latestPrompt: 'hello' })
    })
    expect(calls).toBe(1)
  })
})
