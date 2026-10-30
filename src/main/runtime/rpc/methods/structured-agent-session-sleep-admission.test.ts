import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { structuredAgentSessionCreateFingerprint } from '../../../../shared/structured-agent-session-mutation'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import {
  createRestTestRig,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const owner = {
  clientKind: 'runtime',
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  caller: { kind: 'paired-device', deviceId: 'owner' }
} as const
const foreign = { ...owner, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
let rig: RestTestRig
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher

async function sleepWorkspace(client: RpcDispatchStreamingOptions, markAsleep = true) {
  const frames: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'sleep',
      authToken: 'token',
      method: 'agentSession.sleepWorkspace',
      params: { workspaceId: 'workspace-1', ...(markAsleep ? { markAsleep: true } : {}) }
    },
    (raw) => frames.push(JSON.parse(raw)),
    client
  )
  return frames[0]
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  runtime = new OrcaRuntimeService()
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await abandonStructuredAgentSessionHost(rig.host)
  await rig.dispose()
})

async function createScoped(ordinary = false) {
  const params = createTestParams(
    undefined,
    ordinary
      ? {}
      : {
          launchOrigin: 'work-item-start',
          launchAuthority: { kind: 'paired-device', deviceId: 'owner' }
        }
  )
  return rig.host.create(CREATE_TEST_CALLER, {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: SESSION,
        worktree: 'id:workspace-1',
        agent: params.agent,
        launchOrigin: params.launchOrigin
      })
    }
  })
}

it.each([
  { markAsleep: false, client: foreign, stops: false },
  { markAsleep: true, client: foreign, stops: false },
  { markAsleep: true, client: owner, stops: true }
])(
  'rechecks a pending create after founding, markAsleep=$markAsleep, stops=$stops',
  async ({ markAsleep, client, stops }) => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const commit = rig.store.founding.commit.bind(rig.store.founding)
    vi.spyOn(rig.store.founding, 'commit').mockImplementation(async (...args) => {
      reached()
      await held
      return commit(...args)
    })
    const created = createScoped()
    await waiting
    expect(rig.store.getRecord(SESSION)).toBeNull()
    const effect = vi.spyOn(rig.host, 'sleepWorkspace')
    const abort = vi.spyOn(rig.host['runtimeState'].acquireAborts, 'abort')
    const sleeping = sleepWorkspace(client, markAsleep)
    try {
      await vi.waitFor(() => expect(effect).toHaveBeenCalledOnce())
    } finally {
      release()
    }
    expect(await created).toMatchObject({ ok: true })
    expect(await sleeping).toMatchObject({
      ok: true,
      result: { stoppedSessionIds: stops ? [SESSION] : [] }
    })
    expect(abort).toHaveBeenCalledTimes(stops ? 1 : 0)
    expect(rig.host.hasSession(SESSION)).toBe(!stops)
    expect(rig.store.getRecord(SESSION)?.sleptAt).toBe(stops ? rig.clock.now : undefined)
    expect(rig.store.getRecord(SESSION)?.launchAuthority).toEqual({
      kind: 'paired-device',
      deviceId: 'owner'
    })
  }
)

it.each([false, true])(
  'checks a host appearing during store open, rejectedOpen=%s',
  async (rejectedOpen) => {
    expect(await createScoped()).toMatchObject({ ok: true })
    setStructuredAgentSessionHost(null)
    vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => {
      setStructuredAgentSessionHost(rig.host)
      if (rejectedOpen) {
        throw new Error('store failed while host appeared')
      }
      return rig.store
    })
    const abort = vi.spyOn(rig.host['runtimeState'].acquireAborts, 'abort')
    const result = await sleepWorkspace(foreign, false)
    expect(result).toMatchObject({ ok: true, result: { stoppedSessionIds: [] } })
    expect(abort).not.toHaveBeenCalled()
    expect(rig.host.hasSession(SESSION)).toBe(true)
  }
)

it.each([false, true])(
  'preserves ordinary and owner workspace sleep, ordinary=%s',
  async (ordinary) => {
    expect(await createScoped(ordinary)).toMatchObject({ ok: true })
    expect(await sleepWorkspace(ordinary ? foreign : owner)).toMatchObject({
      ok: true,
      result: { stoppedSessionIds: [SESSION] }
    })
    expect(rig.store.getRecord(SESSION)?.sleptAt).toBe(rig.clock.now)
    expect(rig.host.hasSession(SESSION)).toBe(false)
  }
)
