import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const scopedSessions = ['owner-a', 'owner-b', 'local-session']
const allSessions = [...scopedSessions, 'ordinary-session']

function snapshot(
  version = 1,
  agent: 'codex' | 'claude' = 'codex'
): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'workspace-1',
    publicationEpoch: 'epoch-1',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: 'agent-session:owner-a',
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: 'group-1',
        tabOrder: allSessions.map((id) => `agent-session:${id}`),
        activeTabId: 'agent-session:owner-a',
        recentTabIds: allSessions.map((id) => `agent-session:${id}`)
      }
    ],
    tabs: allSessions.map((sessionId) => ({
      id: `agent-session:${sessionId}`,
      type: 'agent-session',
      sessionId,
      agent,
      title: `Private title ${sessionId}`,
      isActive: sessionId === 'owner-a'
    }))
  }
}

function harness(enabled: boolean, agent: 'codex' | 'claude' = 'codex') {
  const listeners = new Set<(value: RuntimeMobileSessionTabsResult, sequence: number) => void>()
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: enabled }),
    restoreStructuredAgentSessionTabs: vi.fn(async () => undefined),
    listMobileSessionTabs: vi.fn(async () => snapshot(1, agent)),
    activateMobileSessionTab: vi.fn(async () => snapshot(1, agent)),
    closeMobileSessionTab: vi.fn(async () => ({ closed: true })),
    supportsAuthoritativeSessionTabsInventory: () => false,
    listAllMobileSessionTabs: async () => [snapshot(1, agent)],
    listAllMobileSessionTabsWithChangeSequence: async () => ({
      snapshots: [snapshot(1, agent)],
      changeSequence: 1
    }),
    onMobileSessionTabsChanged: vi.fn(
      (listener: (value: RuntimeMobileSessionTabsResult, sequence: number) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    ),
    registerSubscriptionCleanup: vi.fn()
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all runtime methods reached by these RPCs are provided above.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: SESSION_TAB_METHODS
  })
  return {
    runtime,
    async call(method: string, client: RpcDispatchStreamingOptions, tabId?: string) {
      const replies: {
        ok: boolean
        result?: RuntimeMobileSessionTabsResult & { snapshots?: RuntimeMobileSessionTabsResult[] }
        error?: unknown
      }[] = []
      await dispatcher.dispatchStreaming(
        {
          id: method,
          authToken: 'test-token',
          method,
          params: {
            ...closeParams(method),
            worktree: 'id:workspace-1',
            ...(tabId ? { tabId } : {})
          }
        },
        (raw) => replies.push(JSON.parse(raw)),
        client
      )
      return replies
    },
    publish: () => listeners.forEach((listener) => listener(snapshot(2, agent), 2))
  }
}

function closeParams(method: string) {
  if (method === 'session.tabs.close') {
    return { reason: 'user' }
  }
  return method === 'session.tabs.closeLifecycle'
    ? { reason: 'cleanup', publicationEpoch: 'epoch-1', terminal: 'pty-1' }
    : {}
}

beforeEach(() => {
  installStructuredHostStub()
  hostCalls.getRecord.mockImplementation((sessionId: string) =>
    scopedSessions.includes(sessionId)
      ? {
          launchOrigin: 'work-item-start',
          launchAuthority:
            sessionId === 'local-session'
              ? { kind: 'local-desktop' }
              : { kind: 'paired-device', deviceId: sessionId }
        }
      : {}
  )
})
afterEach(clearStructuredHostStub)

const callers: {
  name: string
  client: RpcDispatchStreamingOptions
  scoped: string[]
  ordinary: boolean
}[] = [
  {
    name: 'owner A',
    client: { ...STRUCTURED_CLIENT, pairedDeviceId: 'owner-a' },
    scoped: ['owner-a'],
    ordinary: true
  },
  {
    name: 'foreign B',
    client: { ...STRUCTURED_CLIENT, pairedDeviceId: 'owner-b' },
    scoped: ['owner-b'],
    ordinary: true
  },
  {
    name: 'local desktop',
    client: { ...STRUCTURED_CLIENT, localDesktopAuthority: true },
    scoped: scopedSessions,
    ordinary: true
  },
  {
    name: 'Start-only owner',
    client: {
      clientKind: 'runtime',
      clientCapabilities: [WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY],
      pairedDeviceId: 'owner-a'
    },
    scoped: ['owner-a'],
    ordinary: false
  },
  { name: 'in-process session caller', client: {}, scoped: [], ordinary: true },
  {
    name: 'mobile pairing',
    client: { ...STRUCTURED_CLIENT, clientKind: 'mobile', pairedDeviceId: 'owner-a' },
    scoped: [],
    ordinary: true
  },
  {
    name: 'old runtime',
    client: { clientKind: 'runtime', pairedDeviceId: 'owner-a' },
    scoped: [],
    ordinary: false
  }
]

describe.each([false, true])('Work Item Start tabs with global chat %s', (enabled) => {
  describe.each(['session.tabs.close', 'session.tabs.closeLifecycle'])('%s', (method) => {
    it.each([
      { agent: 'codex' as const, claudeCapable: false },
      { agent: 'codex' as const, claudeCapable: true },
      { agent: 'claude' as const, claudeCapable: false },
      { agent: 'claude' as const, claudeCapable: true }
    ])(
      'limits a Start-only caller to its own renderable $agent tab, Claude support $claudeCapable',
      async ({ agent, claudeCapable }) => {
        const h = harness(enabled, agent)
        const client: RpcDispatchStreamingOptions = {
          clientKind: 'runtime',
          pairedDeviceId: 'owner-a',
          clientCapabilities: [
            WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
            ...(claudeCapable ? [CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] : [])
          ]
        }
        for (const sessionId of allSessions) {
          h.runtime.closeMobileSessionTab.mockClear()
          const response = await h.call(method, client, `agent-session:${sessionId}`)
          const allowed = sessionId === 'owner-a' && (agent === 'codex' || claudeCapable)
          expect(response[0]?.ok).toBe(allowed)
          expect(h.runtime.closeMobileSessionTab).toHaveBeenCalledTimes(allowed ? 1 : 0)
        }
      }
    )
  })

  it.each(callers)(
    'projects list, subscriptions and activate consistently for $name',
    async ({ client, scoped, ordinary }) => {
      const h = harness(enabled)
      const visible = [...scoped, ...(ordinary ? ['ordinary-session'] : [])]
      const expectedTabs = visible.map((sessionId) => expect.objectContaining({ sessionId }))
      const list = await h.call('session.tabs.list', client)
      const inventory = await h.call('session.tabs.listAll', client)
      const subscription = await h.call('session.tabs.subscribe', client)
      const allSubscription = await h.call('session.tabs.subscribeAll', client)
      for (const replies of [list, inventory, subscription, allSubscription]) {
        expect(replies[0]?.ok).toBe(true)
      }
      const initial = list[0]?.result
      expect(initial?.tabs).toEqual(expectedTabs)
      expect(inventory[0]?.result?.snapshots).toEqual([initial])
      expect(subscription[0]?.result).toEqual({ ...initial, type: 'snapshot' })
      expect(allSubscription[0]?.result?.snapshots).toEqual([initial])

      h.publish()
      expect(subscription[1]?.result).toEqual({ ...initial, snapshotVersion: 2, type: 'updated' })
      expect(allSubscription[1]?.result).toEqual(subscription[1]?.result)

      if (visible[0]) {
        const activation = await h.call(
          'session.tabs.activate',
          client,
          `agent-session:${visible[0]}`
        )
        expect(activation[0]).toMatchObject({ ok: true, result: initial })
        expect(h.runtime.activateMobileSessionTab).toHaveBeenCalledOnce()
      }
      for (const hidden of allSessions.filter((id) => !visible.includes(id))) {
        for (const replies of [list, inventory, subscription, allSubscription]) {
          expect(JSON.stringify(replies)).not.toContain(hidden)
        }
        if (client.clientKind) {
          const callsBefore = h.runtime.activateMobileSessionTab.mock.calls.length
          const activation = await h.call(
            'session.tabs.activate',
            client,
            `agent-session:${hidden}`
          )
          expect(activation[0]?.ok).toBe(false)
          expect(h.runtime.activateMobileSessionTab).toHaveBeenCalledTimes(callsBefore)
        }
      }
      expect(h.runtime.listMobileSessionTabs).toHaveBeenCalledWith(
        'id:workspace-1',
        client.pairedDeviceId
      )
      expect(h.runtime.onMobileSessionTabsChanged).toHaveBeenCalledWith(
        expect.any(Function),
        client.pairedDeviceId
      )
    }
  )
})
