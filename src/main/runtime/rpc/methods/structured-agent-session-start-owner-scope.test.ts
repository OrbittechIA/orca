// Work Item Start sessions stay reachable by their owner alone, with the global setting off, and a
// Start-only client never gains the generic structured-session surface.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  attachParams,
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub
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
      experimentalStructuredNativeChat: globalEnabled,
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
  hostCalls.restartResume = vi.fn(async (ids: readonly string[] | undefined) =>
    (ids ?? RECORDS.map((record) => record.sessionId)).map((sessionId) => ({ sessionId }))
  )
  hostCalls.restartContinue = vi.fn(async () => ({ continued: true }))
  Object.assign(host, {
    hold: hostCalls.hold,
    restartResume: {
      list: hostCalls.restartList,
      resume: hostCalls.restartResume,
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
    expect(hostCalls.hold).toHaveBeenCalledTimes(1)
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
        'agentSession.restartResume',
        { sessionIds: ['session-start-a'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject({ ok: true })
    expect(hostCalls.restartResume).toHaveBeenLastCalledWith(
      ['session-start-a'],
      expect.any(String)
    )

    hostCalls.restartResume.mockClear()
    await expect(
      call(
        'agentSession.restartResume',
        { sessionIds: ['session-start-b'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    await expect(
      call(
        'agentSession.restartResume',
        { sessionIds: ['session-start-a', 'session-ordinary'] },
        startClient('device-a'),
        OFF
      )
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.restartResume).not.toHaveBeenCalled()
  })

  it("narrows an omitted list to the caller's own sessions", async () => {
    await call('agentSession.restartResume', {}, startClient('device-a'), OFF)
    expect(hostCalls.restartResume).toHaveBeenCalledWith(['session-start-a'], expect.any(String))

    await call('agentSession.restartContinue', {}, startClient('device-b'), OFF)
    expect(hostCalls.restartContinue).toHaveBeenCalledWith(['session-start-b'], expect.any(String))
  })

  it('refuses a Start-capable caller that owns no Start session', async () => {
    await expect(
      call('agentSession.restartResume', {}, startClient('device-c'), OFF)
    ).resolves.toMatchObject(UNSUPPORTED)
    expect(hostCalls.restartResume).not.toHaveBeenCalled()
  })

  it("keeps a global caller away from another owner's Start session", async () => {
    const globalClient = startClient('device-a', STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    await call('agentSession.restartResume', {}, globalClient, settings(true))
    expect(hostCalls.restartResume).toHaveBeenLastCalledWith(
      ['session-start-a', 'session-ordinary'],
      expect.any(String)
    )

    hostCalls.restartList.mockResolvedValue([{ sessionId: 'session-ordinary' }])
    await call('agentSession.restartResume', {}, globalClient, settings(true))
    // Nothing dropped, so the global path keeps its exact v1.4.209 call.
    expect(hostCalls.restartResume).toHaveBeenLastCalledWith(undefined, expect.any(String))
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
