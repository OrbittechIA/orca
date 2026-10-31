import { expect, it, vi } from 'vitest'
import { SelectionWatchSchema } from '../../../src/shared/worktree/custody-selection'
import type { WorktreeCustodyFence } from '../../../src/shared/worktree/custody'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import { mobileWorkspaceSelection } from './workspace-selection-custody'

const firstChannel = '11111111-1111-4111-8111-111111111111'
const secondChannel = '22222222-2222-4222-8222-222222222222'
const fence: WorktreeCustodyFence = {
  resource: {
    worktreeId: 'folder:background',
    path: '/fixture/workspace',
    instanceId: 'instance',
    hostId: 'local',
    owner: 'orchestration',
    product: 'product',
    task: 'task',
    generation: 'one'
  },
  token: '33333333-3333-4333-8333-333333333333',
  authorityId: firstChannel,
  capturedAt: 1,
  expiresAt: 2
}
function physical() {
  const base = new FakeSession('connected')
  base.sendRequest.mockImplementation(async () => ({
    id: 'fixture',
    ok: true,
    result: { reported: true, acknowledged: true, reconciled: true }
  }))
  const streams: {
    params: unknown
    receive(value: unknown): void
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, params, receive) => {
    const stop = vi.fn()
    streams.push({ params, receive, stop })
    return stop
  })
  const client: RpcClient = { ...base, subscribe }
  return { base, client, streams }
}
function ready(
  stream: ReturnType<typeof physical>['streams'][number],
  channelNonce = firstChannel,
  connectionId = 'native-one'
) {
  const watch = SelectionWatchSchema.parse(stream.params)
  stream.receive({
    type: 'ready',
    clientIncarnation: watch.clientIncarnation,
    channelNonce,
    connectionId,
    subscriptionId: `selection:${channelNonce}`
  })
  return { clientIncarnation: watch.clientIncarnation, channelNonce, connectionId }
}

it('reports actual folder/background leases on the same client and refuses without stopping the mounted route', async () => {
  const fixture = physical()
  const logical = createStableLogicalRpcClient(fixture.client, 'lan')
  const selection = mobileWorkspaceSelection(logical)
  const release = selection.mount(fence.resource.worktreeId)
  const stream = fixture.streams[0]
  const channel = ready(stream)
  stream.receive({
    type: 'fence',
    round: { ...channel, fence, nonce: '44444444-4444-4444-8444-444444444444' }
  })
  await vi.waitFor(() =>
    expect(fixture.base.sendRequest).toHaveBeenCalledWith(
      'workspace.selection.ack.v1',
      expect.objectContaining({ disposition: 'held', connectionId: 'native-one', fence }),
      { failWhenDisconnected: true }
    )
  )
  expect(selection.hasMounted(fence.resource.worktreeId)).toBe(true)
  expect(selection.canSelect('unrelated')).toBe(true)
  expect(fixture.base.close).not.toHaveBeenCalled()
  expect(SelectionWatchSchema.parse(stream.params).pendingFences).toEqual([fence])
  release?.()
  logical.close()
})

it('retains admission across actual logical migration, replays current state and ignores old stream release', async () => {
  const first = physical()
  const logical = createStableLogicalRpcClient(first.client, 'lan')
  const selection = mobileWorkspaceSelection(logical)
  const firstStream = first.streams[0]
  const oldChannel = ready(firstStream)
  firstStream.receive({
    type: 'fence',
    round: { ...oldChannel, fence, nonce: '44444444-4444-4444-8444-444444444444' }
  })
  const replacement = physical()
  await logical.migrateTo(replacement.client, 'tailscale')
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(false)
  expect(replacement.streams).toHaveLength(1)
  const newStream = replacement.streams[0]
  expect(SelectionWatchSchema.parse(newStream.params).pendingFences).toEqual([fence])
  const current = ready(newStream, secondChannel, 'native-two')
  firstStream.receive({
    type: 'settled',
    channelNonce: oldChannel.channelNonce,
    fence,
    proof: 'late-old-connection'
  })
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(false)
  newStream.receive({
    type: 'settled',
    channelNonce: current.channelNonce,
    fence,
    proof: 'native-durable-result'
  })
  expect(selection.canSelect(fence.resource.worktreeId)).toBe(true)
  expect(replacement.base.close).not.toHaveBeenCalled()
  logical.close()
})

it('an old host or malformed report never creates an acknowledged selection channel or stops the client', async () => {
  const fixture = physical()
  const selection = mobileWorkspaceSelection(fixture.client)
  fixture.streams[0].receive({ error: { code: 'method_not_found' } })
  expect(selection.isReady()).toBe(false)
  mobileWorkspaceSelection(fixture.client)
  expect(fixture.streams).toHaveLength(1)
  expect(fixture.base.close).not.toHaveBeenCalled()
  fixture.base.publishState('disconnected')
  fixture.base.publishState('connected')
  expect(fixture.streams).toHaveLength(2)
  fixture.base.sendRequest.mockResolvedValue({ id: 'refused', ok: true, result: {} })
  ready(fixture.streams[1])
  await vi.waitFor(() => expect(selection.isReady()).toBe(false))
  expect(fixture.base.close).not.toHaveBeenCalled()
})
