import { describe, expect, it, vi, type Mock } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import { SESSION_TAB_METHODS } from './session-tabs'
import { visibleSnapshot } from './session-tabs-snapshot.test-fixture'

const registry = vi.hoisted((): { host: unknown } => ({ host: null }))
vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => registry.host
}))

type StartRecordFixture = {
  sessionId: string
  launchOrigin: 'work-item-start' | undefined
  launchAuthority: { kind: 'paired-device'; deviceId: string } | undefined
}

function paired(deviceId: string): { kind: 'paired-device'; deviceId: string } {
  return { kind: 'paired-device', deviceId }
}

/** `closed-start` is absent from the persisted visible index, as a tab closed before restart is. */
function installStartRecords(records: StartRecordFixture[]): void {
  const byId = new Map(records.map((record) => [record.sessionId, record]))
  registry.host = {
    deps: { store: { getRecord: (id: string) => byId.get(id), listRecords: () => records } },
    getPersistedVisibleSessionTabIndex: () => ({
      present: true,
      sessionIds: records.map((r) => r.sessionId).filter((id) => id !== 'closed-start')
    }),
    revealSession: vi.fn(async () => ({ readable: true, agent: 'codex', workspaceId: 'wt-1' }))
  }
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(experimentalStructuredNativeChat: boolean): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session.tabs.list reaches only the runtime members stubbed here.
  return {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: vi.fn(() => ({ experimentalStructuredNativeChat })),
    restoreStructuredAgentSessionTabs: vi.fn(),
    prepareStructuredAgentSessionStartupRestoration: vi.fn().mockResolvedValue(undefined),
    publishStructuredAgentSessionTab: vi.fn().mockResolvedValue(undefined),
    listMobileSessionTabs: vi.fn().mockResolvedValue(visibleSnapshot())
  } as unknown as OrcaRuntimeService
}

describe('structured session tab restoration follows one rule for every caller', () => {
  it('keeps ordinary structured tabs down for a Start-only runtime with the setting off', async () => {
    const runtime = makeRuntime(false)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'runtime',
        clientCapabilities: [WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY],
        localDesktopAuthority: true
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })

  it("restores only the paired owner's visible Start tabs with the setting off", async () => {
    const runtime = makeRuntime(false)
    installStartRecords([
      {
        sessionId: 'own-start',
        launchOrigin: 'work-item-start',
        launchAuthority: paired('device-web')
      },
      {
        sessionId: 'other-start',
        launchOrigin: 'work-item-start',
        launchAuthority: paired('device-b')
      },
      { sessionId: 'ordinary', launchOrigin: undefined, launchAuthority: undefined },
      {
        sessionId: 'closed-start',
        launchOrigin: 'work-item-start',
        launchAuthority: paired('device-web')
      }
    ])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const context = {
      clientKind: 'runtime' as const,
      clientCapabilities: [WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY],
      pairedDeviceId: 'device-web'
    }

    await dispatcher.dispatch(makeRequest('session.tabs.list', { worktree: 'id:wt-1' }), context)
    await dispatcher.dispatch(makeRequest('session.tabs.list', { worktree: 'id:wt-1' }), context)

    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
    const published = vi
      .mocked(runtime.publishStructuredAgentSessionTab)
      .mock.calls.map(([input]) => input.sessionId)
    expect(published).toEqual(['own-start'])
  })

  it('lets a second owner restore its own Start tab after the first owner swept', async () => {
    const runtime = makeRuntime(false)
    installStartRecords([
      {
        sessionId: 'a-start',
        launchOrigin: 'work-item-start',
        launchAuthority: paired('device-a')
      },
      {
        sessionId: 'b-start',
        launchOrigin: 'work-item-start',
        launchAuthority: paired('device-b')
      }
    ])
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    for (const deviceId of ['device-a', 'device-b']) {
      await dispatcher.dispatch(makeRequest('session.tabs.list', { worktree: 'id:wt-1' }), {
        clientKind: 'runtime',
        clientCapabilities: [WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY],
        pairedDeviceId: deviceId
      })
    }

    const published = vi
      .mocked(runtime.publishStructuredAgentSessionTab)
      .mock.calls.map(([input]) => input.sessionId)
    expect(published).toEqual(['a-start', 'b-start'])
  })

  it('restores for the desktop renderer once the host setting is on', async () => {
    const runtime = makeRuntime(true)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'runtime',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('restores for an in-process caller on the same setting that admits remote clients', async () => {
    const restoreCallsBySetting = new Map<boolean, number>()
    for (const enabled of [false, true]) {
      const runtime = makeRuntime(enabled)
      const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

      await dispatcher.dispatch(makeRequest('session.tabs.list', { worktree: 'id:wt-1' }))

      restoreCallsBySetting.set(
        enabled,
        (runtime.restoreStructuredAgentSessionTabs as unknown as Mock).mock.calls.length
      )
    }

    expect(restoreCallsBySetting.get(false)).toBe(0)
    expect(restoreCallsBySetting.get(true)).toBe(1)
  })
})

describe('session tab structured restore gating', () => {
  it('does not restore structured tabs for mobile while the host setting is off', async () => {
    const runtime = makeRuntime(false)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).not.toHaveBeenCalled()
  })

  // Why: an old build has no capability to advertise, and skipping the restore left it with
  // nothing to project after a desktop restart — neither the chat nor its fallback row.
  it('restores structured tabs for a mobile client that advertises no capability', async () => {
    const runtime = makeRuntime(true)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      { clientKind: 'mobile', clientCapabilities: [] }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })

  it('restores structured tabs for mobile once the setting is present', async () => {
    const runtime = makeRuntime(true)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('session.tabs.list', { worktree: 'id:wt-1' }),
      {
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )

    expect(response.ok).toBe(true)
    expect(runtime.restoreStructuredAgentSessionTabs).toHaveBeenCalledTimes(1)
  })
})
