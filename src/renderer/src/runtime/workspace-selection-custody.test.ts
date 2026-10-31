import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { SelectionFrame } from '../../../shared/worktree/custody-selection'
import type { RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

type DiagnosticsListener = Parameters<
  NonNullable<Window['api']['runtimeEnvironments']['onSharedControlDiagnostics']>
>[0]
type StatusListener = Parameters<Window['api']['runtimeEnvironments']['onStatusChanged']>[0]

const mocks = vi.hoisted(() => {
  const owners = new Map<string, RuntimeClientTarget>()
  const state = { activeWorktreeId: 'selected', activeWorkspaceExecutionHostId: null }
  return {
    owners,
    state,
    web: false,
    call: vi.fn(),
    subscribe: vi.fn(),
    stateSubscribe: vi.fn((_callback: () => void) => () => {}),
    diagnostics: vi.fn((_callback: DiagnosticsListener) => () => {}),
    status: vi.fn((_callback: StatusListener) => () => {})
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: mocks.stateSubscribe
  }
}))
vi.mock('@/store/slices/worktrees/listing/worktree-owner-target', () => ({
  tryRuntimeTargetForWorktreeOwner: (_state: unknown, id: string, hostId?: string) =>
    hostId?.startsWith('runtime:')
      ? { kind: 'environment', environmentId: hostId.slice('runtime:'.length) }
      : (mocks.owners.get(id) ?? null)
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('./runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: mocks.subscribe }))
type Stream = {
  target: RuntimeClientTarget
  params: { clientIncarnation: string }
  handlers: RuntimeRpcSubscriptionHandlers
}
const streams: Stream[] = []
const channelNonce = '11111111-1111-4111-8111-111111111111'
const fence = {
  resource: {
    worktreeId: 'target',
    path: '/fixture',
    instanceId: 'one',
    hostId: 'local',
    owner: 'orchestration',
    product: 'product',
    task: 'task',
    generation: 'one'
  },
  token: '22222222-2222-4222-8222-222222222222',
  authorityId: channelNonce,
  capturedAt: 1,
  expiresAt: 2
}
let stop: (() => void) | undefined
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  streams.length = 0
  mocks.web = false
  mocks.state.activeWorktreeId = 'selected'
  mocks.owners.clear()
  for (const id of ['selected', 'target', 'other', 'folder:background']) {
    mocks.owners.set(id, { kind: 'local' })
  }
  mocks.call.mockResolvedValue({ reported: true, reconciled: true, acknowledged: true })
  mocks.subscribe.mockImplementation(
    async (
      target: RuntimeClientTarget,
      _method: string,
      params: Stream['params'],
      handlers: RuntimeRpcSubscriptionHandlers
    ) => {
      streams.push({ target, params, handlers })
      return { unsubscribe: vi.fn() }
    }
  )
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        list: async () => [{ id: 'browser-host' }],
        onStatusChanged: mocks.status,
        onSharedControlDiagnostics: mocks.diagnostics
      }
    }
  })
})
afterEach(() => {
  stop?.()
  stop = undefined
  vi.unstubAllGlobals()
})
function ready(stream: Stream) {
  stream.handlers.onEvent({
    type: 'ready',
    channelNonce,
    clientIncarnation: stream.params.clientIncarnation,
    connectionId: 'native-connection'
  })
}
function latestStream(): Stream {
  const stream = streams.at(-1)
  if (!stream) {
    throw new Error('expected a runtime custody stream')
  }
  return stream
}
function round(stream: Stream, worktreeId: string): SelectionFrame {
  return {
    type: 'fence',
    round: {
      channelNonce,
      clientIncarnation: stream.params.clientIncarnation,
      connectionId: 'native-connection',
      nonce: '33333333-3333-4333-8333-333333333333',
      fence: { ...fence, resource: { ...fence.resource, worktreeId } }
    }
  }
}

it('reads selected and mounted folder/background views and guards only new target admissions', async () => {
  const api = await import('./workspace-selection-custody')
  api.registerMountedWorkspaceReader(() => new Set(['folder:background']))
  stop = api.startWorkspaceSelectionCustody()
  const local = streams[0]
  ready(local)
  local.handlers.onEvent(round(local, 'folder:background'))
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'workspace.selection.ack.v1',
    expect.objectContaining({ disposition: 'held' })
  )
  local.handlers.onEvent(round(local, 'target'))
  expect(api.canSelectWorkspace('target')).toBe(false)
  expect(api.canSelectWorkspace('other')).toBe(true)
  expect(api.canMountWorkspace('selected')).toBe(true)
  expect(api.canMountWorkspace('target')).toBe(false)
  local.handlers.onClose()
  expect(api.canSelectWorkspace('target')).toBe(false)
})

it('keeps same-ID workspaces on different execution hosts separate and holds on unknown mounted owners', async () => {
  const api = await import('./workspace-selection-custody')
  api.registerMountedWorkspaceReader(() => new Set(['unresolved-owner']))
  stop = api.startWorkspaceSelectionCustody()
  const local = streams[0]
  ready(local)
  local.handlers.onEvent(round(local, 'target'))
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'workspace.selection.ack.v1',
    expect.objectContaining({ disposition: 'unknown' })
  )
  expect(api.canSelectWorkspace('target', 'runtime:another-host')).toBe(true)
  expect(api.canSelectWorkspace('target')).toBe(false)
})

it('uses a single real browser environment target, including local-owner aliases', async () => {
  mocks.web = true
  const api = await import('./workspace-selection-custody')
  stop = api.startWorkspaceSelectionCustody()
  await Promise.resolve()
  expect(streams).toHaveLength(1)
  expect(streams[0].target).toEqual({ kind: 'environment', environmentId: 'browser-host' })
  ready(streams[0])
  streams[0].handlers.onEvent(round(streams[0], 'selected'))
  expect(mocks.call).toHaveBeenCalledWith(
    streams[0].target,
    'workspace.selection.ack.v1',
    expect.objectContaining({ disposition: 'held' })
  )
  streams[0].handlers.onEvent(round(streams[0], 'target'))
  expect(api.canSelectWorkspace('target')).toBe(false)
})

it.each(['custody_unsupported', 'custody_selection_native_inventory_unknown', 'method_not_found'])(
  'latches watch refusal until the actual connection changes: %s',
  async (code) => {
    const target = { kind: 'environment', environmentId: 'paired-host' } as const
    mocks.owners.set('selected', target)
    mocks.owners.set('target', target)
    const api = await import('./workspace-selection-custody')
    stop = api.startWorkspaceSelectionCustody()
    const diagnostics = mocks.diagnostics.mock.calls[0][0]
    const event = {
      environmentId: 'paired-host',
      transportGeneration: 1,
      diagnostics: {
        state: 'ready',
        pendingRequestCount: 0,
        subscriptionCount: 0,
        reconnectAttempt: 0,
        lastConnectedAt: 100,
        lastClose: null,
        lastError: null
      }
    } as const
    diagnostics(event)
    const current = latestStream()
    ready(current)
    current.handlers.onEvent(round(current, 'target'))
    current.handlers.onError({ code, message: code })
    const attempts = mocks.subscribe.mock.calls.length
    for (let i = 0; i < 20; i++) {
      mocks.stateSubscribe.mock.calls[0][0]()
      api.ensureWorkspaceSelectionCustody(target)
      diagnostics(event)
    }
    expect(mocks.subscribe).toHaveBeenCalledTimes(attempts)
    expect(api.canSelectWorkspace('target')).toBe(false)
    expect(api.canSelectWorkspace('other')).toBe(true)
    diagnostics({ ...event, transportGeneration: 2 })
    expect(mocks.subscribe).toHaveBeenCalledTimes(attempts + 1)
    expect(latestStream().params).toEqual(expect.objectContaining({ pendingFences: [fence] }))
    current.handlers.onError({ code })
    ready(latestStream())
    expect(api.canSelectWorkspace('target')).toBe(false)
  }
)

it('does not retry a rejected local watch promise on subsequent store updates', async () => {
  mocks.subscribe.mockRejectedValueOnce(new Error('custody_selection_native_inventory_unknown'))
  const api = await import('./workspace-selection-custody')
  stop = api.startWorkspaceSelectionCustody()
  await Promise.resolve()
  await Promise.resolve()
  for (let i = 0; i < 20; i++) {
    mocks.stateSubscribe.mock.calls[0][0]()
  }
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(api.canSelectWorkspace('other')).toBe(true)
})

it('keeps failed selection reports terminal for the current watch without affecting ordinary navigation', async () => {
  const api = await import('./workspace-selection-custody')
  stop = api.startWorkspaceSelectionCustody()
  ready(streams[0])
  await Promise.resolve()
  await Promise.resolve()
  mocks.call.mockRejectedValueOnce(new Error('custody_selection_report_unconfirmed'))
  mocks.state.activeWorktreeId = 'other'
  mocks.stateSubscribe.mock.calls[0][0]()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  for (let i = 0; i < 20; i++) {
    mocks.stateSubscribe.mock.calls[0][0]()
  }
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(api.canSelectWorkspace('other')).toBe(true)
})

it('retries browser custody after actual contact returns while duplicate ready statuses leave a refusal latched', async () => {
  mocks.web = true
  const api = await import('./workspace-selection-custody')
  stop = api.startWorkspaceSelectionCustody()
  await Promise.resolve()
  const status = mocks.status.mock.calls[0][0]
  const event = {
    environmentId: 'browser-host',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 100,
    status: null,
    verification: 'verified',
    transport: 'ready'
  } as const
  status(event)
  const current = latestStream()
  ready(current)
  current.handlers.onEvent(round(current, 'target'))
  current.handlers.onError({ code: 'custody_unsupported' })
  const attempts = mocks.subscribe.mock.calls.length
  for (let i = 0; i < 20; i++) {
    status({ ...event, sequence: i + 2 })
    mocks.stateSubscribe.mock.calls[0][0]()
  }
  expect(mocks.subscribe).toHaveBeenCalledTimes(attempts)
  expect(api.canSelectWorkspace('target')).toBe(false)
  status({ ...event, transport: 'disconnected' })
  status(event)
  expect(mocks.subscribe).toHaveBeenCalledTimes(attempts + 1)
  expect(latestStream().params).toEqual(expect.objectContaining({ pendingFences: [fence] }))
})
