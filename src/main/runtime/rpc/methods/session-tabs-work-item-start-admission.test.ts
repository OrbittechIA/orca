import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { hostTestState } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { projectSessionTabsForContext } from './session-tabs-inventory'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

afterEach(() => setStructuredAgentSessionHost(null))

const START_IDS = ['owner-open', 'other-open', 'desktop-open', 'owner-closed', 'unowned', 'missing']

function setup(nativeChat: boolean) {
  const { host } = hostTestState()
  const records = new Map(
    [
      agentSessionRecordFixture({ sessionId: 'ordinary', provider: 'codex' }),
      ...['owner-open', 'owner-closed'].map((sessionId) =>
        agentSessionRecordFixture({
          sessionId,
          provider: 'codex',
          launchOrigin: 'work-item-start',
          launchAuthority: { kind: 'paired-device', deviceId: 'owner' }
        })
      ),
      agentSessionRecordFixture({
        sessionId: 'other-open',
        provider: 'codex',
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: 'other' }
      }),
      agentSessionRecordFixture({
        sessionId: 'desktop-open',
        provider: 'codex',
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'local-desktop' }
      }),
      agentSessionRecordFixture({
        sessionId: 'unowned',
        provider: 'codex',
        launchOrigin: 'work-item-start'
      })
    ].map((record) => [record.sessionId, record] as const)
  )
  const open = new Set(['owner-open', 'other-open', 'desktop-open', 'unowned'])
  vi.spyOn(host.deps.store, 'getRecord').mockImplementation((id) => records.get(id) ?? null)
  vi.spyOn(host, 'isSessionTabVisible').mockImplementation((id) => open.has(id))
  setStructuredAgentSessionHost(host)

  const snapshot: RuntimeMobileSessionTabsResult = {
    ...visibleSnapshot(),
    activeGroupId: 'scoped',
    activeTabId: 'agent-session:owner-closed',
    activeTabType: 'agent-session',
    tabs: [
      ...visibleSnapshot().tabs.map((tab) => ({ ...tab, isActive: false })),
      ...['ordinary', ...START_IDS].map((sessionId) => ({
        type: 'agent-session' as const,
        id: `agent-session:${sessionId}`,
        sessionId,
        title: sessionId,
        agent: 'codex' as const,
        isActive: sessionId === 'owner-closed'
      }))
    ],
    tabGroups: [
      {
        id: 'ordinary',
        activeTabId: 'tab-1',
        tabOrder: ['tab-1', 'agent-session:ordinary']
      },
      {
        id: 'scoped',
        activeTabId: 'agent-session:owner-closed',
        tabOrder: START_IDS.map((id) => `agent-session:${id}`),
        recentTabIds: START_IDS.toReversed().map((id) => `agent-session:${id}`)
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'ordinary' },
      second: { type: 'leaf', groupId: 'scoped' }
    }
  }
  const registry = new RuntimeSubscriptionRegistry()
  let listener: ((snapshot: RuntimeMobileSessionTabsResult, sequence: number) => void) | undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher exercises only these runtime boundaries; admission uses the real host gate.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => ({ experimentalNativeChat: nativeChat }),
    restoreStructuredAgentSessionTabs: async () => undefined,
    listMobileSessionTabs: async () => snapshot,
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabs: async () => [snapshot],
    listAllMobileSessionTabsWithChangeSequence: async () => ({
      snapshots: [snapshot],
      changeSequence: 0
    }),
    onMobileSessionTabsChanged: (next: typeof listener) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    registerSubscriptionCleanup: registry.register.bind(registry),
    cleanupSubscription: registry.cleanup.bind(registry),
    cleanupSubscriptionsByPrefix: registry.cleanupByPrefix.bind(registry),
    getSubscriptionRegistrationVersion: registry.getRegistrationVersion.bind(registry)
  } as unknown as OrcaRuntimeService
  return {
    host,
    dispatcher: new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }),
    snapshot,
    open,
    records,
    update: () => listener?.({ ...snapshot, snapshotVersion: 2 }, 1)
  }
}

const CALLERS = [
  { name: 'desktop', client: { caller: { kind: 'desktop' } }, visible: ['desktop-open'] },
  {
    name: 'owner phone',
    client: { clientKind: 'mobile', caller: { kind: 'paired-device', deviceId: 'owner' } },
    visible: ['owner-open']
  },
  {
    name: 'other paired runtime',
    client: { clientKind: 'runtime', caller: { kind: 'paired-device', deviceId: 'other' } },
    visible: ['other-open']
  },
  {
    name: 'foreign phone',
    client: { clientKind: 'mobile', caller: { kind: 'paired-device', deviceId: 'foreign' } },
    visible: []
  },
  { name: 'local CLI', client: { caller: { kind: 'local-cli' } }, visible: [] },
  { name: 'absent client kind and caller', client: {}, visible: [] },
  { name: 'unknown mobile caller', client: { clientKind: 'mobile' }, visible: [] }
] as const

function expectAdmitted(snapshot: RuntimeMobileSessionTabsResult, visible: readonly string[]) {
  expect(snapshot.tabs.map((tab) => tab.id)).toEqual([
    'tab-1::leaf-1',
    'agent-session:ordinary',
    ...visible.map((id) => `agent-session:${id}`)
  ])
  for (const hidden of START_IDS.filter((id) => !visible.includes(id))) {
    expect(JSON.stringify(snapshot)).not.toContain(hidden)
  }
  expect(snapshot.activeTabId).toBe('tab-1::leaf-1')
  expect(snapshot.activeTabType).toBe('terminal')
  expect(snapshot.activeGroupId).toBe('ordinary')
  if (visible.length === 0) {
    expect(snapshot.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'ordinary' })
  }
}

describe.each([false, true])('Work Item Start tabs with native chat %s', (nativeChat) => {
  it.each(CALLERS)('lists only admitted open tabs for $name', async ({ client, visible }) => {
    const { dispatcher } = setup(nativeChat)
    for (const method of ['session.tabs.list', 'session.tabs.listAll']) {
      const frames: {
        ok: boolean
        result: RuntimeMobileSessionTabsResult & { snapshots?: RuntimeMobileSessionTabsResult[] }
      }[] = []
      await dispatcher.dispatchStreaming(
        {
          id: method,
          authToken: 'tok',
          method,
          params: method.endsWith('All') ? undefined : { worktree: 'id:wt-1' }
        },
        (frame) => frames.push(JSON.parse(frame)),
        { ...client, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
      )
      expect(frames).toHaveLength(1)
      expect(frames[0]?.ok).toBe(true)
      const result = frames[0]!.result
      expectAdmitted(result.snapshots?.[0] ?? result, visible)
    }
  })

  it.each(CALLERS)(
    'filters initial and live subscription frames for $name',
    async ({ client, visible }) => {
      for (const method of ['session.tabs.subscribe', 'session.tabs.subscribeAll']) {
        const { dispatcher, update, open, records, snapshot } = setup(nativeChat)
        const frames: {
          ok: boolean
          result: RuntimeMobileSessionTabsResult & { snapshots?: RuntimeMobileSessionTabsResult[] }
        }[] = []
        await dispatcher.dispatchStreaming(
          {
            id: method,
            authToken: 'tok',
            method,
            params: method.endsWith('All') ? undefined : { worktree: 'id:wt-1' }
          },
          (frame) => frames.push(JSON.parse(frame)),
          { ...client, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
        )
        expect(frames[0]?.ok).toBe(true)
        const initial = frames[0]!.result
        expectAdmitted(initial.snapshots?.[0] ?? initial, visible)
        const unchanged = structuredClone(snapshot)
        for (const id of visible) {
          open.delete(id)
        }
        records.delete('other-open')
        update()
        expect(frames).toHaveLength(2)
        expectAdmitted(frames[1]!.result, [])
        expect(snapshot).toEqual(unchanged)
      }
    }
  )
})

it('keeps ordinary mobile fallback rows while withholding scoped rows from old clients', () => {
  const { snapshot } = setup(false)
  const projected = projectSessionTabsForContext(snapshot, {
    clientKind: 'mobile',
    clientCapabilities: [],
    caller: { kind: 'paired-device', deviceId: 'owner' }
  })
  expectAdmitted(projected, [])
  expect(projected.tabs[1]?.title).toBe('Update to view')
})

it('omits unproved chat rows when the host is unavailable without hiding other tabs', () => {
  const { snapshot } = setup(false)
  setStructuredAgentSessionHost(null)
  const projected = projectSessionTabsForContext(snapshot, { caller: { kind: 'desktop' } })
  expect(projected.tabs.map((tab) => tab.id)).toEqual(['tab-1::leaf-1'])
  expect(projected.activeTabType).toBe('terminal')
})

it('admits read-only conversations using their persisted launch authority', () => {
  const { snapshot, host, records } = setup(false)
  const ordinary = records.get('ordinary')!
  const scoped = records.get('owner-open')!
  records.delete('ordinary')
  records.delete('owner-open')
  const conversations = new Map([
    ['ordinary', agentSessionConversationView(ordinary)],
    ['owner-open', agentSessionConversationView(scoped)]
  ])
  vi.spyOn(host.deps.store, 'getConversation').mockImplementation(
    (id) => conversations.get(id) ?? null
  )
  const projected = projectSessionTabsForContext(snapshot, {
    clientKind: 'mobile',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    caller: { kind: 'paired-device', deviceId: 'owner' }
  })
  expectAdmitted(projected, ['owner-open'])
})

it('selects the replacement tab group when the hidden tab group still has an ordinary chat', () => {
  const { snapshot } = setup(false)
  const scoped = snapshot.tabGroups?.find((group) => group.id === 'scoped')
  const ordinary = snapshot.tabGroups?.find((group) => group.id === 'ordinary')
  expect(scoped).toBeDefined()
  expect(ordinary).toBeDefined()
  snapshot.tabGroups = [
    { ...scoped!, tabOrder: [...scoped!.tabOrder, 'agent-session:ordinary'] },
    { ...ordinary!, tabOrder: ['tab-1'] }
  ]
  const projected = projectSessionTabsForContext(snapshot, { caller: { kind: 'local-cli' } })
  expect(projected.tabGroups).toHaveLength(2)
  expect(projected.activeTabId).toBe('tab-1::leaf-1')
  expect(projected.activeGroupId).toBe('ordinary')
})
