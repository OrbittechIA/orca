import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { isUnknownRecord } from '../../../src/shared/unknown-record'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../src/shared/worktree/retired-name-registry'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { MobileComposerCreateSelection } from '../tasks/mobile-composer-source-types'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { WORK_ITEM_START_ADMISSION_TIMEOUT_MS } from '../tasks/work-item-start-route'
import { useNewWorkspaceCreateSubmit } from './use-new-workspace-create-submit'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

const ISSUE_URL = 'https://github.com/OrbittechIA/orca/issues/58'
const selection: MobileComposerCreateSelection = {
  kind: 'work-item',
  item: {
    provider: 'github',
    type: 'issue',
    number: 58,
    title: 'Fix Start',
    url: ISSUE_URL,
    repoId: 'repo-1'
  }
}
const strictSettings = { workItemStartPromptDelivery: 'submit-after-ready' as const }
const admitted = {
  capabilities: [WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY],
  deviceScope: 'runtime'
}
type Args = Parameters<typeof useNewWorkspaceCreateSubmit>[0]

function reply(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientAnswering(status: unknown = admitted, settings: unknown = strictSettings) {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string) => {
    switch (method) {
      case 'settings.get':
        if (settings instanceof Error) {
          throw settings
        }
        return reply({ settings })
      case 'status.get':
        if (status instanceof Error) {
          throw status
        }
        return reply(status)
      case 'worktree.create':
        return reply({ worktree: { id: 'wt-1', displayName: 'Fix Start' } })
      case 'agentSession.createSupport':
        return reply({ supported: true })
      case 'agentSession.create':
        return reply({
          ok: true,
          fence: 2,
          value: { sessionId: 'session-1', fence: 2, page: {}, unconfirmedClientMessageIds: [] }
        })
      case 'agentSession.send':
        return reply({
          ok: true,
          value: { clientMessageId: 'message-1', submission: { dispatchState: 'accepted' } }
        })
      default:
        throw new Error(`Unexpected request ${method}`)
    }
  })
  return client
}

function requestParams(client: FakeSession, method: string) {
  const value = client.sendRequest.mock.calls.find((call) => call[0] === method)?.[1]
  if (!isUnknownRecord(value)) {
    throw new Error(`Missing ${method} request`)
  }
  return value
}

let renderer: ReactTestRenderer | null = null
let submit: ReturnType<typeof useNewWorkspaceCreateSubmit> | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  submit = null
})

async function mount(client: FakeSession, overrides: Partial<Args> = {}, source = selection) {
  const callbacks = {
    onClose: vi.fn(),
    onCreated: vi.fn(),
    setError: vi.fn(),
    setRuntimeSettings: vi.fn()
  }
  function Harness() {
    const composer = useMobileComposerSource({ client, selectedRepoId: 'repo-1' })
    submit = useNewWorkspaceCreateSubmit({
      client,
      selectedRepo: { id: 'repo-1', displayName: 'Orca', path: '/repo' },
      selectedAgent: { id: 'codex', label: 'Codex' },
      setSelectedAgent: vi.fn(),
      setAgentOverridden: vi.fn(),
      runtimeSettings: strictSettings,
      detectedAgentIds: null,
      sshGate: { status: null, requiresConnection: false, connectInProgress: false, error: null },
      composer: { ...composer, name: 'Fix Start', createSelection: source },
      note: '',
      retiredWorktreeNames: EMPTY_RETIRED_NAME_REGISTRY,
      setupCommand: null,
      setupTrust: null,
      setupRunPolicy: 'skip-by-default',
      setupDecisionChoice: null,
      runSetup: false,
      trustedOrcaHooks: {},
      setTrustedOrcaHooks: vi.fn(),
      getWorktreeCreateCutoverSupport: async () => false,
      getAgentLaunchSupport: async () => false,
      transitionDrawer: vi.fn(),
      ...callbacks,
      ...overrides
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  return callbacks
}

async function createOnce() {
  if (!submit) {
    throw new Error('Hook not mounted')
  }
  const current = submit
  await act(async () => current.create())
}

function expectStrictCreate(client: FakeSession) {
  expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
    'settings.get',
    'status.get',
    'agentSession.createSupport',
    'worktree.create',
    'agentSession.createSupport',
    'agentSession.create',
    'agentSession.send'
  ])
  expect(requestParams(client, 'worktree.create')).not.toHaveProperty('startupDraft')
  expect(requestParams(client, 'worktree.create')).not.toHaveProperty('startupAgent')
  // The first probe is the repo-scoped pre-create check.
  expect(requestParams(client, 'agentSession.createSupport')).toMatchObject({
    repo: 'id:repo-1',
    launchOrigin: 'work-item-start'
  })
  expect(requestParams(client, 'agentSession.create')).toMatchObject({
    launchOrigin: 'work-item-start'
  })
  expect(requestParams(client, 'agentSession.send')).toMatchObject({
    body: { blocks: [{ type: 'text', text: ISSUE_URL }] }
  })
}

describe('new-workspace production submit hook', () => {
  it('creates without a terminal startup and launches/sends once in runtime scope', async () => {
    const client = clientAnswering()
    const callbacks = await mount(client)
    if (!submit) {
      throw new Error('Hook not mounted')
    }
    const current = submit
    await act(async () => {
      await Promise.all([current.create(), current.create()])
    })
    expectStrictCreate(client)
    expect(callbacks.onCreated).toHaveBeenCalledExactlyOnceWith('wt-1', 'Fix Start', undefined)
    expect(callbacks.onClose).toHaveBeenCalledOnce()
    expect(callbacks.setError).toHaveBeenCalledExactlyOnceWith('')
  })

  it('uses the refreshed strict settings before React can rerender the caller', async () => {
    const client = clientAnswering()
    const callbacks = await mount(client, {
      runtimeSettings: { workItemStartPromptDelivery: 'draft' }
    })
    await createOnce()
    expectStrictCreate(client)
    expect(callbacks.setRuntimeSettings).toHaveBeenCalledWith(strictSettings)
  })

  it('preserves known strict settings when the refresh fails', async () => {
    const client = clientAnswering(admitted, new Error('settings unavailable'))
    await mount(client)
    await createOnce()
    expectStrictCreate(client)
  })

  it.each([undefined, null, false, 'invalid', [], {}, { workItemStartPromptDelivery: 'invalid' }])(
    'preserves strict admission after an incomplete settings refresh: %j',
    async (settings) => {
      const client = clientAnswering({ capabilities: [], deviceScope: 'runtime' }, settings)
      const original = client.sendRequest.getMockImplementation()!
      client.sendRequest.mockImplementation(async (method, params) =>
        method === 'settings.get' ? reply({ settings }) : original(method, params)
      )
      const callbacks = await mount(client)
      await createOnce()
      expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
        'settings.get',
        'status.get'
      ])
      expect(callbacks.setError).toHaveBeenLastCalledWith(
        expect.stringContaining('Nothing was created')
      )
      expect(callbacks.onCreated).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['old host', { capabilities: [], deviceScope: 'runtime' }],
    ['mobile scope', { ...admitted, deviceScope: 'mobile' }],
    ['timeout', new Error('status.get timed out')]
  ])('creates zero worktrees or terminals for %s', async (_label, status) => {
    const client = clientAnswering(status)
    const callbacks = await mount(client)
    await createOnce()
    expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'settings.get',
      'status.get'
    ])
    expect(client.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: WORK_ITEM_START_ADMISSION_TIMEOUT_MS
    })
    expect(callbacks.setError).toHaveBeenLastCalledWith(
      expect.stringContaining('Nothing was created')
    )
    expect(callbacks.onCreated).not.toHaveBeenCalled()
    expect(callbacks.onClose).not.toHaveBeenCalled()
  })

  it('preserves draft compatibility with an old host', async () => {
    const client = clientAnswering({}, { workItemStartPromptDelivery: 'draft' })
    const callbacks = await mount(client)
    await createOnce()
    expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'settings.get',
      'worktree.create'
    ])
    expect(requestParams(client, 'worktree.create')).toMatchObject({ startupDraft: ISSUE_URL })
    expect(callbacks.onCreated).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'new-branch', branchName: 'feature/start' },
    { kind: 'branch', baseBranch: 'main', refName: 'main', localBranchName: 'main', reuse: false }
  ] satisfies MobileComposerCreateSelection[])(
    'preserves $kind Start under strict settings',
    async (source) => {
      const client = clientAnswering({})
      const callbacks = await mount(client, {}, source)
      await createOnce()
      expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
        'settings.get',
        'worktree.create'
      ])
      expect(requestParams(client, 'worktree.create')).toMatchObject({ startupAgent: 'codex' })
      expect(callbacks.onCreated).toHaveBeenCalledOnce()
    }
  )
})
