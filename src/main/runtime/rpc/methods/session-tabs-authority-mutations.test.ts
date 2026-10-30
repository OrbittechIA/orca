import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { delegatedMobileSessionTabClose } from '../../mobile-session-tab-close-outcome'
import { seedTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

const owner = {
  clientKind: 'runtime',
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  caller: { kind: 'paired-device', deviceId: 'owner' }
} as const
const foreign = { ...owner, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
const MUTATIONS = [
  { method: 'session.tabs.close', effect: 'closeMobileSessionTab', params: { reason: 'user' } },
  {
    method: 'session.tabs.closeLifecycle',
    effect: 'closeMobileSessionTab',
    params: { reason: 'cleanup', publicationEpoch: 'epoch-1', terminal: 'pty-1' }
  },
  { method: 'session.tabs.activate', effect: 'activateMobileSessionTab', params: {} },
  {
    method: 'session.tabs.move',
    effect: 'moveMobileSessionTab',
    params: { kind: 'split', targetGroupId: 'ordinary', splitDirection: 'right' }
  },
  {
    method: 'session.tabs.move',
    effect: 'moveMobileSessionTab',
    params: { kind: 'move-to-group', targetGroupId: 'ordinary', index: 0 }
  },
  {
    method: 'session.tabs.move',
    effect: 'moveMobileSessionTab',
    params: { kind: 'reorder', targetGroupId: 'scoped', tabOrder: ['scoped'] }
  },
  {
    method: 'session.tabs.updatePaneLayout',
    effect: 'updateMobileSessionPaneLayout',
    params: { root: null }
  },
  {
    method: 'session.tabs.movePaneToNewTab',
    effect: 'moveMobileSessionLeafToNewTab',
    params: { targetTabId: 'new-tab', leafId: 'leaf-1' }
  },
  {
    method: 'session.tabs.setTabProps',
    effect: 'setMobileSessionTabProps',
    params: { isPinned: true }
  }
] as const
let rig: RestTestRig
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let snapshot: RuntimeMobileSessionTabsResult

async function call(method: string, params: unknown, client: RpcDispatchStreamingOptions = owner) {
  const frames: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: 'mutation', authToken: 'token', method, params },
    (raw) => frames.push(JSON.parse(raw)),
    client
  )
  return frames[0]
}

function mutationParams(mutation: (typeof MUTATIONS)[number], tabId: string) {
  return {
    worktree: 'id:wt-1',
    ...mutation.params,
    ...(mutation.method === 'session.tabs.movePaneToNewTab' ? { sourceTabId: tabId } : { tabId })
  }
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  await abandonStructuredAgentSessionHost(rig.host)
  await seedTestAgentSessionRecordStore(rig.root, {
    records: [
      agentSessionRecordFixture({ sessionId: 'session-ordinary', provider: 'codex' }),
      agentSessionRecordFixture({
        sessionId: 'session-scoped',
        provider: 'codex',
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: 'owner' }
      }),
      agentSessionRecordFixture({
        sessionId: 'session-desktop',
        provider: 'codex',
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'local-desktop' }
      }),
      agentSessionRecordFixture({
        sessionId: 'session-unowned',
        provider: 'codex',
        launchOrigin: 'work-item-start'
      })
    ],
    sessionTabs: ['ordinary', 'scoped', 'desktop', 'unowned'].map((id) => ({
      tabId: id,
      sessionId: `session-${id}`
    }))
  })
  await rig.restart()
  expect(rig.store.getRecord('session-scoped')?.launchAuthority).toEqual({
    kind: 'paired-device',
    deviceId: 'owner'
  })
  expect(rig.store.isSessionTabVisible('session-scoped')).toBe(true)
  setStructuredAgentSessionHost(rig.host)
  snapshot = {
    ...visibleSnapshot(),
    activeTabId: 'scoped',
    activeTabType: 'agent-session',
    activeGroupId: 'scoped',
    tabs: [
      ...visibleSnapshot().tabs.map((tab) => ({ ...tab, isActive: false })),
      ...['ordinary', 'scoped', 'desktop', 'unowned', 'missing'].map((sessionId) => ({
        type: 'agent-session' as const,
        id: sessionId,
        sessionId: `session-${sessionId}`,
        title: sessionId,
        agent: 'codex' as const,
        isActive: sessionId === 'scoped'
      }))
    ],
    tabGroups: [
      { id: 'ordinary', activeTabId: 'tab-1', tabOrder: ['tab-1', 'ordinary'] },
      { id: 'scoped', activeTabId: 'scoped', tabOrder: ['scoped'] },
      { id: 'desktop', activeTabId: 'desktop', tabOrder: ['desktop', 'unowned', 'missing'] }
    ]
  }
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'listMobileSessionTabs').mockResolvedValue(snapshot)
  vi.spyOn(runtime, 'closeMobileSessionTab').mockResolvedValue(delegatedMobileSessionTabClose())
  vi.spyOn(runtime, 'activateMobileSessionTab').mockImplementation(async () => ({
    ...snapshot,
    startupCwdFallback: 'workspace-root'
  }))
  vi.spyOn(runtime, 'moveMobileSessionTab').mockResolvedValue({ moved: true })
  vi.spyOn(runtime, 'updateMobileSessionPaneLayout').mockResolvedValue({ updated: true })
  vi.spyOn(runtime, 'moveMobileSessionLeafToNewTab').mockResolvedValue({ status: 'not_held' })
  vi.spyOn(runtime, 'setMobileSessionTabProps').mockResolvedValue({ updated: true })
  vi.spyOn(runtime, 'createMobileSessionTerminal').mockResolvedValue({
    tab: visibleSnapshot().tabs[0]!,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1
  })
  dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await abandonStructuredAgentSessionHost(rig.host)
  await rig.dispose()
})

it.each(MUTATIONS)('refuses foreign $method before its runtime effect', async (mutation) => {
  for (const client of [
    foreign,
    { ...foreign, pairedDeviceId: 'owner', clientId: 'owner' },
    {},
    { caller: { kind: 'local-cli' } as const }
  ]) {
    for (const tabId of ['scoped', 'unowned', 'missing']) {
      expect(await call(mutation.method, mutationParams(mutation, tabId), client)).toMatchObject({
        ok: false
      })
    }
  }
  expect(runtime[mutation.effect]).not.toHaveBeenCalled()
  expect(rig.store.isSessionTabVisible('session-scoped')).toBe(true)
})

it.each(MUTATIONS)('admits the proven owner for $method', async (mutation) => {
  expect(await call(mutation.method, mutationParams(mutation, 'scoped'))).toMatchObject({
    ok: true
  })
  expect(runtime[mutation.effect]).toHaveBeenCalledOnce()
})

it('filters the activation response after admitting an ordinary tab', async () => {
  const response = await call(
    'session.tabs.activate',
    { worktree: 'id:wt-1', tabId: 'ordinary' },
    foreign
  )
  expect(response).toMatchObject({
    ok: true,
    result: {
      tabs: [{ type: 'terminal' }, { id: 'ordinary' }],
      activeTabId: 'tab-1::leaf-1',
      startupCwdFallback: 'workspace-root'
    }
  })
  expect(JSON.stringify(response)).not.toContain('scoped')
  expect(JSON.stringify(response)).not.toContain('desktop')
})

it('uses the real desktop caller even without clientKind and refuses a foreign desktop close', async () => {
  const params = { worktree: 'id:wt-1', reason: 'user' }
  expect(
    await call(
      'session.tabs.close',
      { ...params, tabId: 'scoped' },
      { caller: { kind: 'desktop' } }
    )
  ).toMatchObject({ ok: false })
  expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
  expect(
    await call(
      'session.tabs.close',
      { ...params, tabId: 'desktop' },
      { caller: { kind: 'desktop' } }
    )
  ).toMatchObject({ ok: true })
  expect(runtime.closeMobileSessionTab).toHaveBeenCalledOnce()
})

it('refuses closed scoped tabs and preserves ordinary legacy mobile mutations', async () => {
  await rig.store.setSessionTabVisibility('session-scoped', false)
  expect(
    await call('session.tabs.activate', { worktree: 'id:wt-1', tabId: 'scoped' })
  ).toMatchObject({ ok: false })
  expect(runtime.activateMobileSessionTab).not.toHaveBeenCalled()
  expect(
    await call(
      'session.tabs.activate',
      { worktree: 'id:wt-1', tabId: 'ordinary' },
      { clientKind: 'mobile', clientCapabilities: [] }
    )
  ).toMatchObject({ ok: true })
  expect(
    await call(
      'session.tabs.close',
      { worktree: 'id:wt-1', tabId: 'tab-1', reason: 'user' },
      { clientKind: 'mobile', clientCapabilities: [] }
    )
  ).toMatchObject({ ok: true })
})

it('translates reorders without letting the caller name hidden tabs', async () => {
  snapshot.tabGroups = [
    { id: 'ordinary', activeTabId: 'tab-1', tabOrder: ['tab-1', 'scoped', 'ordinary'] }
  ]
  expect(
    await call(
      'session.tabs.move',
      {
        worktree: 'id:wt-1',
        tabId: 'ordinary',
        targetGroupId: 'ordinary',
        kind: 'reorder',
        tabOrder: ['ordinary', 'tab-1']
      },
      foreign
    )
  ).toMatchObject({ ok: true })
  expect(runtime.moveMobileSessionTab).toHaveBeenCalledWith('id:wt-1', {
    tabId: 'ordinary',
    targetGroupId: 'ordinary',
    kind: 'reorder',
    tabOrder: ['ordinary', 'scoped', 'tab-1']
  })
  expect(
    await call(
      'session.tabs.move',
      {
        worktree: 'id:wt-1',
        tabId: 'ordinary',
        targetGroupId: 'ordinary',
        kind: 'reorder',
        tabOrder: ['ordinary', 'scoped', 'tab-1']
      },
      foreign
    )
  ).toMatchObject({ ok: false })
  expect(runtime.moveMobileSessionTab).toHaveBeenCalledOnce()
})

it('refuses a pane move whose target id belongs to a hidden tab', async () => {
  expect(
    await call(
      'session.tabs.movePaneToNewTab',
      {
        worktree: 'id:wt-1',
        sourceTabId: 'tab-1',
        targetTabId: 'scoped',
        leafId: 'leaf-1'
      },
      foreign
    )
  ).toMatchObject({ ok: false })
  expect(runtime.moveMobileSessionLeafToNewTab).not.toHaveBeenCalled()
})

it('admits chat forks by persisted source authority before terminal creation', async () => {
  const params = {
    worktree: 'id:wt-1',
    sourceChatFork: { sessionId: 'session-scoped' },
    clientMutationId: 'fork-1'
  }
  expect(await call('session.tabs.createTerminal', params, foreign)).toMatchObject({ ok: false })
  expect(runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  expect(await call('session.tabs.createTerminal', params)).toMatchObject({ ok: true })
  expect(runtime.createMobileSessionTerminal).toHaveBeenCalledOnce()
})
