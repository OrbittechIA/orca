import { STRUCTURED_AGENT_SESSION_AGENTS_METHODS } from './structured-agent-session-agents'
// Work Item Start sessions stay reachable by their owner alone, with the global setting off, and a
// Start-only client never gains the generic structured-session surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls
} from './structured-agent-session-rpc.test-fixture'

type Owner = { kind: 'paired-device'; deviceId: string } | { kind: 'local-desktop' }

const RECORDS: {
  sessionId: string
  launchOrigin?: 'work-item-start'
  launchAuthority?: Owner
}[] = [
  {
    sessionId: 'session-start-a',
    launchOrigin: 'work-item-start',
    launchAuthority: { kind: 'paired-device', deviceId: 'device-a' }
  },
  {
    sessionId: 'session-start-b',
    launchOrigin: 'work-item-start',
    launchAuthority: { kind: 'paired-device', deviceId: 'device-b' }
  },
  { sessionId: 'session-ordinary' }
]

function startClient(
  deviceId: string,
  capability: string = WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
) {
  return {
    clientId: `token-${deviceId}`,
    connectionId: `connection-${deviceId}`,
    clientKind: 'runtime' as const,
    clientCapabilities: [capability],
    pairedDeviceId: deviceId
  }
}

function settings(globalEnabled: boolean) {
  return {
    getClientSettings: () => ({
      experimentalNativeChat: globalEnabled,
      workItemStartPromptDelivery: 'submit-after-ready'
    }),
    registerOwnedSubscriptionCleanup: vi.fn(() => ({ releaseIfCurrent: vi.fn() }))
  }
}

const OFF = settings(false)
const UNSUPPORTED = {
  ok: false,
  error: { message: expect.stringContaining('structured_agent_session_unsupported') }
}

beforeEach(() => {
  installStructuredHostStub()
  const byId = new Map(RECORDS.map((record) => [record.sessionId, record]))
  hostCalls.getRecord.mockImplementation((id: string) => byId.get(id) ?? null)
  hostCalls.listRecords.mockImplementation(() => RECORDS)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured host stub missing')
  }
  hostCalls.hold = vi.fn(async () => undefined)
  hostCalls.restartList = vi.fn(async () =>
    RECORDS.map((record) => ({ sessionId: record.sessionId }))
  )
  hostCalls.restartContinue = vi.fn(async (ids: readonly string[] | undefined) =>
    (ids ?? RECORDS.map((record) => record.sessionId)).map((sessionId) => ({ sessionId }))
  )
  Object.assign(host, {
    hold: hostCalls.hold,
    restartResume: {
      list: hostCalls.restartList,
      listFailures: vi.fn(async () => []),
      continueAfterRestart: hostCalls.restartContinue
    }
  })
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.hold with the global setting off', () => {
  it('lets the owner hold its own Start session', async () => {
    await expect(
      call(
        'agentSession.hold',
        { sessionId: 'session-start-a', holderId: 'chat' },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject({ ok: true, result: { held: true } })
    expect(hostCalls.hold).not.toHaveBeenCalled()
  })

  it('refuses another paired device holding that Start session', async () => {
    await expect(
      call(
        'agentSession.hold',
        { sessionId: 'session-start-a', holderId: 'chat' },
        startClient('device-b'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.hold).not.toHaveBeenCalled()
  })

  it('refuses the owner holding an ordinary structured session', async () => {
    await expect(
      call(
        'agentSession.hold',
        { sessionId: 'session-ordinary', holderId: 'chat' },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.hold).not.toHaveBeenCalled()
  })
})

describe('restart resume with the global setting off', () => {
  it("lists only the caller's own Start sessions", async () => {
    await expect(
      call('agentSession.restartResumable', {}, startClient('device-a'), OFF)
    ).resolves.toMatchObject({
      ok: true,
      result: { sessions: [{ sessionId: 'session-start-a' }] }
    })
  })

  it('resumes a named own session and refuses a named foreign one', async () => {
    await expect(
      call(
        'agentSession.restartContinue',
        { sessionIds: ['session-start-a'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject({ ok: true })
    expect(hostCalls.restartContinue).toHaveBeenLastCalledWith(
      ['session-start-a'],
      expect.any(String),
      expect.any(Function)
    )

    hostCalls.restartContinue.mockClear()
    await expect(
      call(
        'agentSession.restartContinue',
        { sessionIds: ['session-start-b'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    await expect(
      call(
        'agentSession.restartContinue',
        { sessionIds: ['session-start-a', 'session-ordinary'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.restartContinue).not.toHaveBeenCalled()
  })

  it("narrows an omitted list to the caller's own sessions", async () => {
    await call('agentSession.restartContinue', {}, startClient('device-a'), OFF)
    expect(hostCalls.restartContinue).toHaveBeenCalledWith(
      ['session-start-a'],
      expect.any(String),
      expect.any(Function)
    )

    await call('agentSession.restartContinue', {}, startClient('device-b'), OFF)
    expect(hostCalls.restartContinue).toHaveBeenCalledWith(
      ['session-start-b'],
      expect.any(String),
      expect.any(Function)
    )
  })

  it('refuses a Start-capable caller that owns no Start session', async () => {
    await expect(
      call('agentSession.restartContinue', {}, startClient('device-c'), OFF)
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.restartContinue).not.toHaveBeenCalled()
  })

  it("keeps a global caller away from another owner's Start session", async () => {
    const globalClient = startClient('device-a', STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    await call('agentSession.restartContinue', {}, globalClient, settings(true))
    expect(hostCalls.restartContinue).toHaveBeenLastCalledWith(
      ['session-start-a', 'session-ordinary'],
      expect.any(String),
      expect.any(Function)
    )

    hostCalls.restartList.mockResolvedValue([{ sessionId: 'session-ordinary' }])
    await call('agentSession.restartContinue', {}, globalClient, settings(true))
    // Nothing dropped, so the global path keeps its exact v1.4.209 call.
    expect(hostCalls.restartContinue).toHaveBeenLastCalledWith(
      undefined,
      expect.any(String),
      expect.any(Function)
    )
  })
})

describe('a Start-only client capability', () => {
  it('grants no generic structured reach even with the global setting on', async () => {
    await expect(
      call(
        'agentSession.ensure',
        attachParams({ envelope: { ...attachParams().envelope, sessionId: 'session-ordinary' } }),
        startClient('device-a'),
        settings(true)
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    await expect(
      call(
        'agentSession.hold',
        { sessionId: 'session-ordinary', holderId: 'chat' },
        startClient('device-a'),
        settings(true)
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(hostCalls.hold).not.toHaveBeenCalled()
  })

  it('still reaches its own Start session with the global setting on', async () => {
    await expect(
      call(
        'agentSession.hold',
        { sessionId: 'session-start-a', holderId: 'chat' },
        startClient('device-a'),
        settings(true)
      )
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('scoped attention acknowledgement', () => {
  it.each([
    {
      sessionId: 'session-start-a',
      capability: WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
      accepted: true
    },
    {
      sessionId: 'session-start-b',
      capability: WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
      accepted: false
    },
    {
      sessionId: 'session-ordinary',
      capability: WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
      accepted: false
    },
    {
      sessionId: 'session-start-b',
      capability: STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      accepted: false
    },
    {
      sessionId: 'session-ordinary',
      capability: STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      accepted: true
    }
  ])(
    'checks ownership of $sessionId with $capability',
    async ({ sessionId, capability, accepted }) => {
      const retire = vi.fn()
      const install = vi.fn()
      const params = { sessionId, observedCursor: { epoch: 'journal-a', sequence: 10 } }
      const reply = await call(
        'agentSession.acknowledgeAttention',
        params,
        startClient('device-a', capability),
        {
          ...OFF,
          retireStructuredAttention: retire,
          ensureStructuredAgentSessionHost: install
        }
      )
      if (accepted) {
        expect(reply).toMatchObject({ ok: true, result: { acknowledged: true } })
        expect(retire).toHaveBeenCalledWith(params)
      } else {
        expect(reply).toMatchObject(UNSUPPORTED)
        expect(retire).not.toHaveBeenCalled()
      }
      expect(install).not.toHaveBeenCalled()
    }
  )

  it('refuses a Start-only caller without an existing host before retiring attention', async () => {
    clearStructuredHostStub()
    const retire = vi.fn()
    const install = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: 'session-start-a', observedCursor: { epoch: 'journal-a', sequence: 10 } },
      startClient('device-a'),
      { ...OFF, retireStructuredAttention: retire, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject(UNSUPPORTED)
    expect(retire).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })
})

describe('scoped create support preserves agent audience', () => {
  it.each([{ repo: 'id:repo-1' }, { worktree: 'id:workspace-1', sessionId: 'session-start-a' }])(
    'refuses Pi without dialog support before work for %j',
    async (target) => {
      const preCreateSupport = vi.fn()
      const install = vi.fn()
      const reply = await call(
        'agentSession.createSupport',
        { ...target, agent: 'pi', launchOrigin: 'work-item-start' },
        startClient('device-a'),
        {
          ...OFF,
          getWorkItemStartPreCreateSupport: preCreateSupport,
          ensureStructuredAgentSessionHost: install
        }
      )
      expect(reply).toMatchObject(UNSUPPORTED)
      expect(preCreateSupport).not.toHaveBeenCalled()
      expect(runtimeCalls.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
    }
  )
})

describe('scoped interrupted continuation', () => {
  it('restores the durable host before reaching the owned Start session', async () => {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('structured host stub missing')
    }
    const continueInterrupted = vi.fn(async () => ({ continued: true }))
    Object.assign(host.restartResume, { continueInterrupted })
    clearStructuredHostStub()
    const install = vi.fn(async () => setStructuredAgentSessionHost(host))
    const reply = await call(
      'agentSession.continueInterrupted',
      { sessionId: 'session-start-a', turnItemId: 'turn-1' },
      startClient('device-a'),
      { ...OFF, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject({ ok: true, result: { continued: true } })
    expect(install).toHaveBeenCalledOnce()
    expect(continueInterrupted).toHaveBeenCalledWith('session-start-a', 'turn-1')
  })
})

it('refuses the generic agent catalog for a Start-only caller without installing a host', async () => {
  const install = vi.fn()
  await expect(
    call(
      'agentSession.agents',
      {},
      startClient('device-a'),
      {
        ...OFF,
        ensureStructuredAgentSessionHost: install
      },
      STRUCTURED_AGENT_SESSION_AGENTS_METHODS
    )
  ).resolves.toMatchObject(UNSUPPORTED)
  expect(install).not.toHaveBeenCalled()
})
