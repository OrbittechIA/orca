import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import {
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStoreText
} from '../../agent-session-record-store-test-harness'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  call,
  hostStub,
  runtimeCalls,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const owner = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ],
  caller: { kind: 'paired-device', deviceId: 'owner' }
} as const
const desktop = { ...owner, caller: { kind: 'desktop' } } as const
const foreign = { ...owner, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
const target = {
  worktreeId: 'workspace-1',
  workspacePath: '/workspace',
  instanceId: null,
  identityKey: null,
  executionHostId: 'local',
  creatorKind: 'paired-device',
  creatorDeviceId: 'owner'
} as const
const runtime = { resolveStructuredAgentSessionCreateWorktreeTarget: async () => target }
let rig: RestTestRig

function createParams(sessionId = SESSION, scoped = true) {
  return structuredAgentSessionCreateParams({
    sessionId,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW,
    ...(scoped ? { launchOrigin: 'work-item-start' } : {})
  })
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await abandonStructuredAgentSessionHost(rig.host)
  await rig.dispose()
  vi.restoreAllMocks()
})

it.each([
  { client: owner, authority: { kind: 'paired-device', deviceId: 'owner' } },
  { client: desktop, authority: { kind: 'local-desktop' } }
] as const)(
  'creates a missing scoped chat for $authority.kind and replays its owner',
  async ({ client, authority }) => {
    const params = createParams()
    expect(rig.store.selectWritableRecord(SESSION)).toEqual({ kind: 'missing' })
    expect(await call('agentSession.create', params, client, runtime)).toMatchObject({
      ok: true,
      result: { ok: true, replayed: false, value: { sessionId: SESSION } }
    })
    expect(rig.store.getRecord(SESSION)).toMatchObject({
      launchOrigin: 'work-item-start',
      launchAuthority: authority,
      lease: { claimStatus: 'released' }
    })
    const persisted = await readPersistedTestAgentSessionStoreText(rig.root)
    expect(await call('agentSession.create', params, client, runtime)).toMatchObject({
      ok: true,
      result: { ok: true, replayed: true, value: { sessionId: SESSION } }
    })
    expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(persisted)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('refuses foreign scoped and ordinary create attempts before resolving launch identity', async () => {
  expect(await call('agentSession.create', createParams(), owner, runtime)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  const persisted = await readPersistedTestAgentSessionStoreText(rig.root)
  const create = vi.spyOn(rig.host, 'create')
  for (const scoped of [false, true]) {
    expect(
      await call(
        'agentSession.create',
        createParams(SESSION, scoped),
        {
          ...foreign,
          clientId: 'owner',
          pairedDeviceId: 'owner'
        },
        {
          resolveStructuredAgentSessionCreateWorktreeTarget: async () => ({
            ...target,
            creatorDeviceId: 'foreign'
          })
        }
      )
    ).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
    })
    expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
  }
  expect(create).not.toHaveBeenCalled()
  expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(persisted)
})

it('refuses opaque rows without a conversation instead of treating null reads as missing', async () => {
  await editPersistedTestAgentSessionStore(rig.root, (persisted) => {
    persisted.unusableRecords[SESSION] = { reason: 'future-format', raw: { futureFormat: true } }
  })
  await abandonStructuredAgentSessionHost(rig.host)
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  expect(rig.store.getRecord(SESSION)).toBeNull()
  expect(rig.store.getConversation(SESSION)).toBeNull()
  expect(rig.store.listHeldSessionIds()).toContain(SESSION)
  expect(rig.store.selectWritableRecord(SESSION)).toEqual({ kind: 'unreadable' })
  const persisted = await readPersistedTestAgentSessionStoreText(rig.root)
  const attach = vi.spyOn(rig.host, 'attach')
  const create = vi.spyOn(rig.host, 'create')
  for (const params of [createParams(), createParams(SESSION, false), hostTestAttachParams(null)]) {
    expect(await call('agentSession.create', params, owner, runtime)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
    })
  }
  expect(await call('agentSession.ensure', hostTestAttachParams(null), owner)).toMatchObject({
    ok: false,
    error: { message: 'structured_agent_session_unsupported' }
  })
  expect(attach).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(persisted)
})

it('keeps unknown history and streams refused even when the store proves absence', async () => {
  const history = vi.spyOn(rig.host, 'history')
  const subscribe = vi.spyOn(rig.host, 'subscribe')
  expect(rig.store.selectWritableRecord(SESSION)).toEqual({ kind: 'missing' })
  for (const method of ['agentSession.history', 'agentSession.subscribe']) {
    expect(
      await call(
        method,
        {
          sessionId: SESSION,
          ...(method === 'agentSession.history' ? { direction: 'tail' } : {})
        },
        owner
      )
    ).toMatchObject({
      ok: false,
      error: { message: 'structured_agent_session_unsupported' }
    })
  }
  expect(history).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

it('refuses fresh create on an older store that cannot prove absence', async () => {
  const host = hostStub()
  Reflect.deleteProperty(host.deps.store, 'selectWritableRecord')
  setStructuredAgentSessionHost(host)
  const params = createParams('codex_missing')
  const attachParams = hostTestAttachParams(null, { envelope: params.envelope })
  for (const input of [params, attachParams]) {
    expect(await call('agentSession.create', input, owner, runtime)).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
    })
  }
  expect(await call('agentSession.ensure', attachParams, owner)).toMatchObject({
    ok: false,
    error: { message: 'structured_agent_session_unsupported' }
  })
  expect(runtimeCalls.resolveStructuredAgentSessionCreateIntent).not.toHaveBeenCalled()
  expect(host.attach).not.toHaveBeenCalled()
  expect(await call('agentSession.ensure', hostTestAttachParams(null), owner)).toMatchObject({
    ok: true,
    result: { ok: true }
  })
  expect(host.attach).toHaveBeenCalledOnce()
})

it.each(['agentSession.create', 'agentSession.ensure'])(
  'preserves fresh ordinary location attach through %s',
  async (method) => {
    rig.host.deps.adapter.supportsLocation = (location) =>
      location.executionHostId === 'local' && location.wslDistro === null
    const params = hostTestAttachParams(null, {
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      }
    })
    const response = await call(method, params, owner)
    expect(response, JSON.stringify(response)).toMatchObject({
      ok: true,
      result: { ok: true, value: { sessionId: SESSION } }
    })
    expect(rig.store.getRecord(SESSION)).toMatchObject({
      location: { workspaceId: 'folder-1', workspaceKind: 'folder' }
    })
    expect(rig.store.getRecord(SESSION)?.launchOrigin).toBeUndefined()
    expect(rig.store.getRecord(SESSION)?.launchAuthority).toBeUndefined()
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  }
)

it('rechecks a competing create inside the founding transaction after admission proved missing', async () => {
  const commit = rig.store.founding.commit
  vi.spyOn(rig.store.founding, 'commit').mockImplementationOnce(async (request) => {
    await commit({
      ...request,
      launchAuthority: { kind: 'paired-device', deviceId: 'foreign' },
      operation: {
        ...request.operation,
        callerKey: 'competitor',
        operationId: hostTestOperationId()
      }
    })
    return commit(request)
  })
  expect(rig.store.selectWritableRecord(SESSION)).toEqual({ kind: 'missing' })
  expect(await call('agentSession.create', createParams(), owner, runtime)).toMatchObject({
    ok: true,
    result: {
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'sessionExists' } }
    }
  })
  expect(rig.store.getRecord(SESSION)?.launchAuthority).toEqual({
    kind: 'paired-device',
    deviceId: 'foreign'
  })
  expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('rechecks a competing owner inside reserveOwner before legacy create can acquire a child', async () => {
  const reserve = rig.store.reserveOwner
  const reservation = vi
    .spyOn(rig.store, 'reserveOwner')
    .mockImplementationOnce(async (request, check) => {
      await reserve({
        ...request,
        operation: {
          ...request.operation,
          callerKey: 'competitor',
          operationId: hostTestOperationId()
        }
      })
      return reserve(request, check)
    })
  expect(rig.store.selectWritableRecord(SESSION)).toEqual({ kind: 'missing' })
  expect(
    await call('agentSession.create', createParams(SESSION, false), STRUCTURED_CLIENT)
  ).toMatchObject({
    ok: true,
    result: {
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'sessionExists' } }
    }
  })
  expect(reservation).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('reserved')
  expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})
