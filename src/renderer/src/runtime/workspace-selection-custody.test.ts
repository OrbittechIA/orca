import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { SelectionFrame } from '../../../shared/worktree/custody-selection'
import type { RuntimeRpcSubscriptionHandlers } from './runtime-rpc-subscribe'

const mocks = vi.hoisted(() => {
  const owners = new Map<string, RuntimeClientTarget>()
  const state = { activeWorktreeId: 'selected', activeWorkspaceExecutionHostId: null }
  return {
    owners,
    state,
    web: false,
    call: vi.fn(),
    subscribe: vi.fn(),
    stateSubscribe: vi.fn(() => () => {}),
    diagnostics: vi.fn(() => () => {})
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
        onStatusChanged: () => () => {},
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
