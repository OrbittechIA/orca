// Restores Work Item Start chat tabs while global structured chat is off.
//
// The global restore republishes every structured tab and latches the host's readable-restore
// sweep; running it for a Start caller would keep unrelated structured chats alive with the
// feature off, and would spend the latch so enabling the feature later restored nothing else.
// This sweep reads only records whose durable identity is `launchOrigin: 'work-item-start'`, only
// those the caller owns, and reveals each one on demand, which is outside that latch.
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

type WorkItemStartTabRestoreRuntime = {
  prepareStructuredAgentSessionStartupRestoration?: () => Promise<void>
  publishStructuredAgentSessionTab?: (input: {
    workspaceId: string
    sessionId: string
    agent: 'claude' | 'codex'
    activate: boolean
    notify?: boolean
  }) => Promise<void>
}

type SweepState = { attempted: Set<string>; tail: Promise<void> }

const sweeps = new WeakMap<object, SweepState>()

/** Each record is attempted once per runtime, like the global restore: a later sweep would
 *  resurrect a tab closed since. Latching per record rather than per runtime lets each owner
 *  restore its own tabs without one owner's sweep spending another's. */
export function restoreWorkItemStartStructuredAgentSessionTabs(
  runtime: WorkItemStartTabRestoreRuntime,
  callerOwnsSession: (sessionId: string) => boolean
): Promise<void> {
  let state = sweeps.get(runtime)
  if (!state) {
    state = { attempted: new Set(), tail: Promise.resolve() }
    sweeps.set(runtime, state)
  }
  const current = state
  const sweep = current.tail.then(() => sweepWorkItemStartTabs(runtime, current, callerOwnsSession))
  // Serialized so two owners' sweeps never race on the same attempted set.
  current.tail = sweep.catch(() => undefined)
  return sweep
}

async function sweepWorkItemStartTabs(
  runtime: WorkItemStartTabRestoreRuntime,
  state: SweepState,
  callerOwnsSession: (sessionId: string) => boolean
): Promise<void> {
  if (
    typeof runtime.prepareStructuredAgentSessionStartupRestoration !== 'function' ||
    typeof runtime.publishStructuredAgentSessionTab !== 'function'
  ) {
    return
  }
  await runtime.prepareStructuredAgentSessionStartupRestoration()
  const host = getStructuredAgentSessionHost()
  const persisted =
    typeof host?.getPersistedVisibleSessionTabIndex === 'function'
      ? host.getPersistedVisibleSessionTabIndex()
      : null
  // No persisted index means no proof which Start tabs were still open; restoring every record
  // would resurrect closed chats.
  if (!host || !persisted?.present) {
    return
  }
  const visible = new Set(persisted.sessionIds)
  for (const record of host.deps?.store?.listRecords?.() ?? []) {
    if (
      record.launchOrigin !== 'work-item-start' ||
      !visible.has(record.sessionId) ||
      state.attempted.has(record.sessionId) ||
      !callerOwnsSession(record.sessionId)
    ) {
      continue
    }
    state.attempted.add(record.sessionId)
    const revealed = await host.revealSession(record.sessionId).catch(() => null)
    if (!revealed?.readable || (revealed.agent !== 'codex' && revealed.agent !== 'claude')) {
      continue
    }
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: revealed.workspaceId,
      sessionId: record.sessionId,
      agent: revealed.agent,
      activate: false,
      notify: false
    })
  }
}
