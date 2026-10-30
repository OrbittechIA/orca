import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcResponse } from '../core'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStoreText,
  seedTestAgentSessionStoreFromNewerBuild
} from '../../agent-session-record-store-test-harness'
import { abandonStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-abandon'
import { hostTestAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const owner = {
  clientKind: 'runtime',
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  caller: { kind: 'paired-device', deviceId: 'owner' }
} as const
const foreign = { ...owner, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
let rig: RestTestRig
let dispatcher: RpcDispatcher
let sequence = 0

async function call(method: string, params: unknown, client: RpcDispatchStreamingOptions = owner) {
  const frames: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    { id: `read-${++sequence}`, authToken: 'token', method, params },
    (raw) => frames.push(JSON.parse(raw)),
    client
  )
  return frames
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'restoreStructuredAgentSessionTabs').mockResolvedValue(undefined)
  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await abandonStructuredAgentSessionHost(rig.host)
  await rig.dispose()
})

describe.each([false, true])('retained conversations, newer schema=%s', (newerSchema) => {
  async function reopen(ordinary = false) {
    const attached = await rig.host.attach(
      REST_TEST_CALLER,
      hostTestAttachParams(
        null,
        ordinary
          ? {}
          : {
              launchOrigin: 'work-item-start',
              launchAuthority: { kind: 'paired-device', deviceId: 'owner' }
            }
      )
    )
    expect(attached.ok).toBe(true)
    const sent = await rig.host.send(REST_TEST_CALLER, restTestSend('PRIVATE_READ_ONLY_CHAT'))
    expect(sent.ok).toBe(true)
    if (sent.ok) {
      await rig.host.waitForSendSettlement(SESSION, sent.value.clientMessageId)
    }
    await rig.store.setConversationName(SESSION, 'PRIVATE_READ_ONLY_NAME')
    await abandonStructuredAgentSessionHost(rig.host)

    await editPersistedTestAgentSessionStore(rig.root, ({ records }) => {
      Object.assign(records[SESSION].lease, { minimumNextFence: 'bad' })
    })
    if (newerSchema) {
      await seedTestAgentSessionStoreFromNewerBuild(rig.root)
    }
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)
    rig.adapter.acquire.mockClear()
    rig.adapter.dispatch.mockClear()
    expect(rig.store.readOnly).toBe(newerSchema)
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(rig.store.getConversation(SESSION)?.conversationName).toBe('PRIVATE_READ_ONLY_NAME')
  }

  it('refuses foreign history and transcript streams before opening the journal', async () => {
    await reopen()
    const persisted = await readPersistedTestAgentSessionStoreText(rig.root)
    const history = vi.spyOn(rig.host, 'history')
    const subscribe = vi.spyOn(rig.host, 'subscribe')
    for (const client of [
      foreign,
      { ...foreign, pairedDeviceId: 'owner', clientId: 'owner' },
      {
        ...owner,
        caller: { kind: 'local-cli' } as const
      },
      { clientKind: owner.clientKind, clientCapabilities: owner.clientCapabilities }
    ]) {
      expect(
        await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client)
      ).toMatchObject([{ ok: false }])
      expect(await call('agentSession.subscribe', { sessionId: SESSION }, client)).toMatchObject([
        { ok: false }
      ])
    }
    expect(history).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(persisted)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('admits the persisted owner to history and streams without changing authority or starting a child', async () => {
    await reopen()
    const persisted = await readPersistedTestAgentSessionStoreText(rig.root)
    const read = vi.spyOn(rig.host, 'history')
    const history = await call('agentSession.history', { sessionId: SESSION, direction: 'tail' })
    const transcript = await call('agentSession.subscribe', { sessionId: SESSION })
    const statuses = await call('agentSession.subscribeStatus', undefined)
    expect(read).toHaveBeenCalledOnce()
    if (newerSchema) {
      expect(history).toMatchObject([
        { ok: false, error: { message: 'agent_session_journal_unreadable' } }
      ])
    } else {
      expect(history).toMatchObject([{ ok: true, result: { ok: true } }])
      expect(JSON.stringify(history)).toContain('PRIVATE_READ_ONLY_CHAT')
      expect(JSON.stringify(transcript)).toContain('PRIVATE_READ_ONLY_CHAT')
    }
    expect(JSON.stringify(statuses)).toContain('PRIVATE_READ_ONLY_NAME')
    expect(await readPersistedTestAgentSessionStoreText(rig.root)).toBe(persisted)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  })

  it('filters retained status names for foreign callers and denies unknown sessions', async () => {
    await reopen()
    const statuses = await call('agentSession.subscribeStatus', undefined, foreign)
    expect(statuses[0]).toMatchObject({ ok: true, result: { type: 'snapshot' } })
    expect(JSON.stringify(statuses)).not.toContain(SESSION)
    expect(JSON.stringify(statuses)).not.toContain('PRIVATE_READ_ONLY_NAME')
    const history = vi.spyOn(rig.host, 'history')
    expect(
      await call('agentSession.history', { sessionId: 'missing', direction: 'tail' })
    ).toMatchObject([{ ok: false }])
    expect(history).not.toHaveBeenCalled()
  })

  it('filters live naming publications with the same admission as the initial status frames', async () => {
    await reopen()
    const owned = await call('agentSession.subscribeStatus', undefined)
    const other = await call('agentSession.subscribeStatus', undefined, foreign)
    const ownedCount = owned.length
    rig.host.publishConversationName(SESSION)
    expect(owned.length).toBeGreaterThan(ownedCount)
    expect(JSON.stringify(owned.slice(ownedCount))).toContain('PRIVATE_READ_ONLY_NAME')
    expect(JSON.stringify(other)).not.toContain(SESSION)
    expect(JSON.stringify(other)).not.toContain('PRIVATE_READ_ONLY_NAME')
  })

  it('refuses foreign reveal before visibility and publication effects', async () => {
    await reopen()
    const reveal = vi.spyOn(rig.host, 'revealSession')
    const visibility = vi.spyOn(rig.host, 'setSessionTabVisibility')
    expect(await call('agentSession.reveal', { sessionId: SESSION }, foreign)).toMatchObject([
      { ok: true, result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } } }
    ])
    expect(reveal).not.toHaveBeenCalled()
    expect(visibility).not.toHaveBeenCalled()
  })

  it('preserves proven ordinary conversations for other capable devices', async () => {
    await reopen(true)
    const read = vi.spyOn(rig.host, 'history')
    const history = await call(
      'agentSession.history',
      { sessionId: SESSION, direction: 'tail' },
      foreign
    )
    expect(read).toHaveBeenCalledOnce()
    if (newerSchema) {
      expect(history).toMatchObject([
        { ok: false, error: { message: 'agent_session_journal_unreadable' } }
      ])
    } else {
      expect(history).toMatchObject([{ ok: true }])
      expect(
        JSON.stringify(await call('agentSession.subscribe', { sessionId: SESSION }, foreign))
      ).toContain('PRIVATE_READ_ONLY_CHAT')
    }
    expect(
      JSON.stringify(await call('agentSession.subscribeStatus', undefined, foreign))
    ).toContain('PRIVATE_READ_ONLY_NAME')
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  })
})
