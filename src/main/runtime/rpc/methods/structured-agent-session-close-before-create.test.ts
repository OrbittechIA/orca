import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { structuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_NOW as NOW,
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call, runtimeCalls } from './structured-agent-session-rpc.test-fixture'
import {
  resetStructuredAgentSessionClosesBeforeCreateForTests,
  structuredAgentSessionClosedBeforeCreate
} from './structured-agent-session-close-before-create'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
  ]
}

let rig: RestTestRig
const retireTab = vi.fn(() => true)

beforeEach(async () => {
  mocks.layoutOwnerIsMain = true
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  retireTab.mockClear()
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})

function createParams() {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fa',
    now: NOW
  })
}

const create = (overrides: Record<string, unknown> = {}) =>
  call('agentSession.create', createParams(), CLIENT, {
    retireStructuredAgentSessionTabFromSnapshot: retireTab,
    ...overrides
  })
const close = () => call('agentSession.close', { sessionId: SESSION }, CLIENT)

const owner = { ...CLIENT, caller: { kind: 'paired-device', deviceId: 'owner' } } as const
const foreign = { ...CLIENT, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
const scopedParams = () =>
  structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:workspace-1',
    agent: 'codex',
    randomUuid: () => '00000000-0000-0000-0000-0000000000fb',
    now: NOW,
    launchOrigin: 'work-item-start'
  })
const ownerRuntime = {
  retireStructuredAgentSessionTabFromSnapshot: retireTab,
  resolveStructuredAgentSessionCreateWorktreeTarget: async () => ({
    worktreeId: 'workspace-1',
    workspacePath: '/workspace',
    instanceId: null,
    identityKey: null,
    executionHostId: 'local',
    creatorKind: 'paired-device',
    creatorDeviceId: 'owner'
  })
}
const scopedCreate = (overrides: Record<string, unknown> = {}) =>
  call('agentSession.create', scopedParams(), owner, { ...ownerRuntime, ...overrides })
const resolvingAfter = (step: () => Promise<unknown>) =>
  vi.fn(async (params: { envelope: unknown }) => {
    await step()
    return {
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
      runtimeKind: 'native'
    }
  })

const refusedAsClosed = {
  ok: true,
  result: {
    ok: false,
    refusal: {
      code: 'agent_session_operation_invalid',
      message: 'The chat was closed before it was created.'
    }
  }
}

describe('a close that reaches main before its create', () => {
  it('cancel then create: main refuses the create and makes nothing', async () => {
    expect(await close()).toMatchObject({ ok: true })

    expect(await create()).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it('create then cancel: an ordinary close, and the create still replays', async () => {
    expect(await create()).toMatchObject({ ok: true, result: { ok: true } })
    expect(await close()).toMatchObject({ ok: true })

    expect(await create()).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
  })

  it('a close while the create resolves its workspace refuses it before anything is written', async () => {
    const resolving = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const creating = create({
      resolveStructuredAgentSessionCreateIntent: vi.fn(async (params: { envelope: unknown }) => {
        entered.resolve()
        await resolving.promise
        return {
          envelope: params.envelope,
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'git-worktree'
          },
          provider: 'codex',
          agent: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
          runtimeKind: 'native'
        }
      })
    })
    await entered.promise
    await close()
    resolving.resolve()

    expect(await creating).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).toBeNull()
  })

  it('a close while the create commits closes the chat as it lands', async () => {
    let closing: Promise<unknown> | undefined
    const result = await create({
      publishStructuredAgentSessionTab: vi.fn(async () => {
        closing = close()
      })
    })
    await closing

    expect(result).toMatchObject(refusedAsClosed)
    expect(retireTab).toHaveBeenCalledWith(SESSION)
    expect(rig.store.getSessionTabId(SESSION)).toBeNull()
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('a close before a create that fails past commit still closes what it made', async () => {
    let closing: Promise<unknown> | undefined
    const result = await create({
      publishStructuredAgentSessionTab: vi.fn(async () => {
        // Not awaited: the close's stop queues behind this create.
        closing = close()
        await vi.waitFor(() => expect(structuredAgentSessionClosedBeforeCreate(SESSION)).toBe(true))
        throw new Error('tab write failed')
      })
    })

    await closing
    expect(result).toMatchObject(refusedAsClosed)
    expect(rig.store.getRecord(SESSION)).not.toBeNull()
    expect(retireTab).toHaveBeenCalledWith(SESSION)
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('a close main fails for want of its chat host still refuses the create that follows', async () => {
    setStructuredAgentSessionHost(null)
    expect(await close()).toMatchObject({ ok: false })
    setStructuredAgentSessionHost(rig.host)

    expect(await create()).toMatchObject(refusedAsClosed)
    expect(runtimeCalls.publishStructuredAgentSessionTab).not.toHaveBeenCalled()
  })

  it.each([
    ['another paired device', foreign],
    ['an older client without launch authority', CLIENT]
  ])(
    'a close from %s neither fences nor closes a Work Item Start launch it cannot reach',
    async (_, closer) => {
      const closeAs = () => call('agentSession.close', { sessionId: SESSION }, closer)
      expect(await closeAs()).toMatchObject({ ok: true })
      let racing: Promise<unknown> | undefined
      const result = await scopedCreate({
        resolveStructuredAgentSessionCreateIntent: resolvingAfter(async () =>
          expect(await closeAs()).toMatchObject({ ok: true })
        ),
        publishStructuredAgentSessionTab: vi.fn(async () => {
          racing = closeAs()
        })
      })
      expect(result).toMatchObject({ ok: true, result: { ok: true } })
      expect(await racing).toMatchObject({ ok: false })

      // Its own fenced creates are refused and never clean up the owner's chat.
      const visibility = vi.spyOn(rig.host, 'setSessionTabVisibility')
      const stop = vi.spyOn(rig.host, 'close')
      const ordinary = createParams()
      for (const [params, code] of [
        [ordinary, 'structured_agent_session_unsupported'],
        [scopedParams(), 'structured_agent_session_unsupported'],
        [
          hostTestAttachParams(null, { envelope: ordinary.envelope }),
          'structured_agent_session_unsupported'
        ],
        [
          { ...ordinary, envelope: { ...ordinary.envelope, expectedRuntimeFence: 1 } },
          'agent_session_operation_invalid'
        ]
      ] as const) {
        const denied = await call('agentSession.create', params, closer, ownerRuntime)
        expect(JSON.stringify(denied)).toContain(code)
        expect(denied).not.toMatchObject(refusedAsClosed)
      }
      expect(visibility).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      expect(retireTab).not.toHaveBeenCalled()
      expect(rig.store.getRecord(SESSION)).toMatchObject({
        launchOrigin: 'work-item-start',
        launchAuthority: owner.caller
      })
    }
  )

  it.each([
    'before the create',
    'while it resolves',
    'while it commits',
    'before it fails past commit'
  ])("the launch owner's close %s still ends its Work Item Start launch", async (phase) => {
    const closeAsOwner = () => call('agentSession.close', { sessionId: SESSION }, owner)
    let closing: Promise<unknown> | undefined
    if (phase === 'before the create') {
      expect(await closeAsOwner()).toMatchObject({ ok: true })
    }
    const result = await scopedCreate({
      ...(phase === 'while it resolves'
        ? { resolveStructuredAgentSessionCreateIntent: resolvingAfter(closeAsOwner) }
        : {}),
      publishStructuredAgentSessionTab: vi.fn(async () => {
        if (phase === 'while it commits' || phase === 'before it fails past commit') {
          closing = closeAsOwner()
        }
        if (phase === 'before it fails past commit') {
          await vi.waitFor(() =>
            expect(structuredAgentSessionClosedBeforeCreate(SESSION)).toBe(true)
          )
          throw new Error('tab write failed')
        }
      })
    })
    await closing

    expect(result).toMatchObject(refusedAsClosed)
    const committed = phase === 'while it commits' || phase === 'before it fails past commit'
    expect(rig.store.getRecord(SESSION) !== null).toBe(committed)
    expect(retireTab).toHaveBeenCalledTimes(committed ? 1 : 0)
    expect(rig.host.hasSession(SESSION)).toBe(false)
  })

  it('switch off: a close before the create is not remembered', async () => {
    mocks.layoutOwnerIsMain = false
    await close()
    mocks.layoutOwnerIsMain = true

    expect(await create()).toMatchObject({ ok: true, result: { ok: true } })
  })
})
