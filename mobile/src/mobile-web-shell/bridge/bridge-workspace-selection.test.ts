import { afterEach, expect, it, vi } from 'vitest'
import type { WorktreeCustodyFence } from '../../../../src/shared/worktree/custody'
import {
  SelectionAckSchema,
  SelectionWatchSchema,
  WORKTREE_SELECTION_CAPABILITY,
  WORKTREE_SELECTION_BRIDGE_CAPABILITY
} from '../../../../src/shared/worktree/custody-selection'
import { mobileWorkspaceSelection } from '../../transport/workspace-selection-custody'
import { scopeRpcClientToExecutionHost } from '../../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../../transport/rpc-client'
import {
  observeMobileSelectionHosts,
  type MobileSelectionHost
} from '../../transport/workspace-selection-hosts'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'
import { clientFrame, createFakeRpcClient, rpcSuccess } from '../bridge-host-test-fakes'
import { createBridgePortPair, type BridgePortPair } from './bridge-port-pair-test-harness'

const channelNonce = '11111111-1111-4111-8111-111111111111'
const fence: WorktreeCustodyFence = {
  resource: {
    worktreeId: 'folder:page-only',
    path: '/fixture/workspace',
    instanceId: 'instance',
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
const pairs: BridgePortPair<RpcClient>[] = []
afterEach(() => {
  for (const pair of pairs.splice(0)) {
    pair.client.close()
    pair.host.dispose()
  }
})

function native() {
  const transport = createFakeRpcClient()
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async () =>
    rpcSuccess('native', {
      reported: true,
      acknowledged: true,
      reconciled: true
    })
  )
  const client: RpcClient = { ...transport, sendRequest }
  const selection = mobileWorkspaceSelection(client)
  const stream = transport.streams[0]
  const watch = SelectionWatchSchema.parse(stream.params)
  const channel = {
    channelNonce,
    clientIncarnation: watch.clientIncarnation,
    connectionId: 'physical-mobile'
  }
  stream.emit({ type: 'ready', ...channel, subscriptionId: 'native-selection' })
  return {
    client,
    selection,
    transport,
    sendRequest,
    stream,
    fence: () =>
      stream.emit({
        type: 'fence',
        round: { ...channel, fence, nonce: '33333333-3333-4333-8333-333333333333' }
      })
  }
}
function page(client: RpcClient) {
  const pair = createBridgePortPair({ rpc: client })
  pairs.push(pair)
  return pair
}
function acknowledgements(fixture: ReturnType<typeof native>) {
  return fixture.sendRequest.mock.calls.filter(
    ([method]) => method === 'workspace.selection.ack.v1'
  )
}

it('accounts for page-only folder mounts through one physical watch and keeps the mounted page working', async () => {
  const fixture = native()
  const pair = page(fixture.client)
  await pair.flush()
  const selection = mobileWorkspaceSelection(pair.client)
  const release = selection.mount(fence.resource.worktreeId)
  await pair.flush()
  expect(fixture.transport.streams).toHaveLength(1)
  expect(fixture.selection.hasMounted(fence.resource.worktreeId)).toBe(false)
  expect(fixture.selection.selectionSnapshot()).toEqual({
    complete: true,
    workspaceIds: [fence.resource.worktreeId]
  })
  fixture.fence()
  await pair.flush()
  expect(acknowledgements(fixture)).toEqual([
    [
      'workspace.selection.ack.v1',
      expect.objectContaining({ disposition: 'held', fence, connectionId: 'physical-mobile' }),
      { failWhenDisconnected: true }
    ]
  ])
  expect(selection.hasMounted(fence.resource.worktreeId)).toBe(true)
  expect(selection.canSelect('unrelated')).toBe(true)
  expect(fixture.stream.unsubscribes).toBe(0)
  release?.()
})

it('waits for the actual page guard before absent ACK and accepts only the current native settlement', async () => {
  const fixture = native()
  const pair = page(fixture.client)
  await pair.flush()
  const selection = mobileWorkspaceSelection(pair.client)
  await pair.flush()
  fixture.fence()
  expect(fixture.selection.canSelect(fence.resource.worktreeId)).toBe(false)
  expect(acknowledgements(fixture)).toHaveLength(0)
  await pair.flush()
  expect(selection.mount(fence.resource.worktreeId)).toBeNull()
  expect(acknowledgements(fixture)[0]?.[1]).toMatchObject({ disposition: 'absent', fence })
  fixture.stream.emit({
    type: 'settled',
    channelNonce: '44444444-4444-4444-8444-444444444444',
    fence,
    proof: 'old'
  })
  await pair.flush()
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(false)
  fixture.stream.emit({ type: 'settled', channelNonce, fence, proof: 'durable-native-result' })
  await pair.flush()
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(true)
  expect(fixture.selection.canSelect(fence.resource.worktreeId)).toBe(true)
})

it('bootstraps an already active native fence before a late page can mount its target', async () => {
  const fixture = native()
  fixture.fence()
  const pair = page(fixture.client)
  await pair.flush()
  expect(pair.client.getWorkspaceSelectionBootstrap?.()?.scopes).toEqual([
    { executionHost: null, fences: [fence] }
  ])
  const selection = mobileWorkspaceSelection(pair.client)
  expect(selection.mount(fence.resource.worktreeId)).toBeNull()
  expect(selection.mount('unrelated')).toEqual(expect.any(Function))
  await pair.flush()
  expect(fixture.transport.streams).toHaveLength(1)
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(false)
})

it('refuses a stale page ACK locally without opening another native request or watch', async () => {
  const fixture = native()
  const pair = page(fixture.client)
  await pair.flush()
  mobileWorkspaceSelection(pair.client)
  await pair.flush()
  fixture.fence()
  await pair.flush()
  const message = pair
    .readToShell()
    .find((frame) => frame.type === 'request' && frame.method === 'workspace.selection.ack.v1')
  if (message?.type !== 'request') {
    throw new Error('the real page did not acknowledge its round')
  }
  const acknowledgement = SelectionAckSchema.parse(message.params)
  const answer = pair.client.sendRequest('workspace.selection.ack.v1', acknowledgement)
  await pair.flush()
  await expect(answer).resolves.toEqual({
    id: 'bridge-selection',
    ok: false,
    error: {
      code: 'custody_selection_view_ack_changed',
      message: 'custody_selection_view_ack_changed'
    }
  })
  expect(acknowledgements(fixture)).toHaveLength(1)
  expect(fixture.transport.streams).toHaveLength(1)
  expect(mobileWorkspaceSelection(pair.client).canSelect(fence.resource.worktreeId)).toBe(false)
  expect(fixture.selection.canSelect(fence.resource.worktreeId)).toBe(false)

  const hosts: MobileSelectionHost[] = []
  const stopObserving = observeMobileSelectionHosts(fixture.client, (host) => hosts.push(host))
  stopObserving()
  const host = hosts.find((value) => !value.executionHost)
  if (!host) {
    throw new Error('the real native selection host was not represented')
  }
  class UnexpectedSelectionError extends Error {
    code = 'unexpected_selection_fixture'
  }
  const acknowledge = vi.spyOn(host.views, 'acknowledge')
  try {
    for (const failure of [
      new Error('unexpected_selection_fixture'),
      new UnexpectedSelectionError('custody_selection_view_ack_changed'),
      markRpcDeliveryUnknown(new Error('custody_selection_view_ack_changed')),
      Object.assign(new Error('custody_selection_view_ack_changed'), {
        code: 'unexpected_delegate_code',
        cause: new Error('unexpected_delegate_cause')
      })
    ]) {
      acknowledge.mockImplementationOnce(() => {
        throw failure
      })
      const rejected = pair.client
        .sendRequest('workspace.selection.ack.v1', acknowledgement)
        .catch((error: unknown) => error)
      await pair.flush()
      const error = await rejected
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ name: failure.constructor.name, message: failure.message })
      expect(isRpcDeliveryUnknown(error)).toBe(isRpcDeliveryUnknown(failure))
      if ('code' in failure) {
        expect(error).toMatchObject({ code: failure.code })
      }
      if ('cause' in failure) {
        expect(error).toMatchObject({ cause: { message: 'unexpected_delegate_cause' } })
      }
      expect(acknowledgements(fixture)).toHaveLength(1)
      expect(fixture.transport.streams).toHaveLength(1)
      expect(mobileWorkspaceSelection(pair.client).canSelect(fence.resource.worktreeId)).toBe(false)
      expect(fixture.selection.canSelect(fence.resource.worktreeId)).toBe(false)
    }
  } finally {
    acknowledge.mockRestore()
  }
})

it('keeps a legacy or self-closed page unknown without stopping existing page streams', async () => {
  const fixture = native()
  const pair = page(fixture.client)
  await pair.flush()
  mobileWorkspaceSelection(pair.client)
  await pair.flush()
  pair.client.subscribe('worktree.events', {}, () => {})
  await pair.flush()
  const ordinary = fixture.transport.streams[1]
  pair.host.receive(clientFrame({ type: 'ready' }))
  expect(fixture.selection.selectionSnapshot().complete).toBe(false)
  fixture.fence()
  await pair.flush()
  expect(acknowledgements(fixture)[0]?.[1]).toMatchObject({ disposition: 'unknown' })
  const initializations = pair.readToPage().filter((frame) => frame.type === 'init').length
  pair.host.receive(clientFrame({ type: 'ready' }))
  await pair.flush()
  expect(pair.readToPage().filter((frame) => frame.type === 'init')).toHaveLength(initializations)
  expect(ordinary.unsubscribes).toBe(0)
  pair.host.receive(clientFrame({ type: 'close' }))
  expect(fixture.selection.selectionSnapshot().complete).toBe(false)
})

it('cannot apply a queued old report after close and a new document ready', async () => {
  const fixture = native()
  const pair = page(fixture.client)
  await pair.flush()
  mobileWorkspaceSelection(pair.client)
  await pair.flush()
  const report = {
    protocol: WORKTREE_SELECTION_CAPABILITY,
    kind: 'view' as const,
    complete: true,
    workspaceIds: ['old-folder']
  }
  // Close retires the reply, so inspect the owning inventory after the queued body.
  void pair.client.sendRequest('workspace.selection.report.v1', report).catch(() => {})
  pair.drainNow()
  pair.host.receive(clientFrame({ type: 'close' }))
  pair.host.receive(
    clientFrame({
      type: 'ready',
      workspaceSelection: WORKTREE_SELECTION_BRIDGE_CAPABILITY,
      workspaceSelectionDocument: '55555555-5555-4555-8555-555555555555'
    })
  )
  await pair.flush()
  expect(fixture.selection.selectionSnapshot()).toEqual({ complete: false, workspaceIds: [] })
  const current = pair.client.sendRequest('workspace.selection.report.v1', {
    ...report,
    workspaceIds: ['current-folder']
  })
  await pair.flush()
  await expect(current).resolves.toMatchObject({ ok: true, result: { reported: true } })
  expect(fixture.selection.selectionSnapshot()).toEqual({
    complete: false,
    workspaceIds: ['current-folder']
  })
  fixture.fence()
  await pair.flush()
  expect(acknowledgements(fixture)[0]?.[1]).toMatchObject({ disposition: 'unknown', fence })
  expect(fixture.transport.streams).toHaveLength(1)
})

it('keeps an unreported execution host unknown and routes its represented page view to its own channel', async () => {
  const fixture = native()
  const remote = mobileWorkspaceSelection(
    scopeRpcClientToExecutionHost(fixture.client, 'runtime:server-a')
  )
  const stream = fixture.transport.streams[1]
  stream.emit({
    type: 'ready',
    channelNonce: '44444444-4444-4444-8444-444444444444',
    clientIncarnation: SelectionWatchSchema.parse(stream.params).clientIncarnation,
    connectionId: 'physical-server',
    subscriptionId: 'native-server-selection'
  })
  const pair = page(fixture.client)
  await pair.flush()
  mobileWorkspaceSelection(pair.client)
  await pair.flush()
  expect(remote.selectionSnapshot().complete).toBe(false)
  const selected = mobileWorkspaceSelection(
    scopeRpcClientToExecutionHost(pair.client, 'runtime:server-a')
  )
  selected.mount('remote-folder')
  await pair.flush()
  expect(fixture.transport.streams).toHaveLength(2)
  expect(fixture.transport.streams[1].envelope).toEqual({ executionHost: 'runtime:server-a' })
  expect(remote.selectionSnapshot()).toEqual({ complete: true, workspaceIds: ['remote-folder'] })
  expect(fixture.selection.selectionSnapshot()).toEqual({ complete: true, workspaceIds: [] })
})
