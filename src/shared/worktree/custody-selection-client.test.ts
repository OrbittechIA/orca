import { expect, it } from 'vitest'
import { WorktreeSelectionClient } from './custody-selection-client'
import type { WorktreeCustodyFence } from './custody'

const incarnation = '11111111-1111-4111-8111-111111111111'
const channelNonce = '22222222-2222-4222-8222-222222222222'
const fence: WorktreeCustodyFence = {
  resource: {
    worktreeId: 'target',
    path: '/fixture/target',
    instanceId: 'instance',
    hostId: 'local',
    owner: 'orchestration',
    product: 'product',
    task: 'task',
    generation: 'generation'
  },
  token: '33333333-3333-4333-8333-333333333333',
  authorityId: incarnation,
  capturedAt: 1,
  expiresAt: 2
}
const ready = {
  type: 'ready' as const,
  channelNonce,
  clientIncarnation: incarnation,
  connectionId: 'connection'
}
const round = {
  nonce: '44444444-4444-4444-8444-444444444444',
  channelNonce,
  clientIncarnation: incarnation,
  connectionId: 'connection',
  fence
}

it('closes only the target before acknowledging actual absence', () => {
  const client = new WorktreeSelectionClient(incarnation, () => ({
    complete: true,
    workspaceIds: []
  }))
  client.receive(ready)
  expect(client.receive({ type: 'fence', round })?.disposition).toBe('absent')
  expect(client.canSelect('target')).toBe(false)
  expect(client.canSelect('unrelated')).toBe(true)
  expect(client.mount('target')).toBeNull()
  client.disconnect()
  expect(client.canSelect('target')).toBe(false)
})

it('retains mounted background and folder consumers without unmounting their existing view', () => {
  const client = new WorktreeSelectionClient(incarnation, () => ({
    complete: true,
    workspaceIds: ['folder:open']
  }))
  const release = client.mount('target')
  client.receive(ready)
  expect(client.receive({ type: 'fence', round })?.disposition).toBe('held')
  expect(client.hasMounted('target')).toBe(true)
  expect(
    client.receive({
      type: 'fence',
      round: {
        ...round,
        fence: { ...fence, resource: { ...fence.resource, worktreeId: 'folder:open' } }
      }
    })?.disposition
  ).toBe('held')
  release?.()
})

it('requires the current connection/incarnation and cannot release a newer target fence by replay', () => {
  const client = new WorktreeSelectionClient(incarnation, () => ({
    complete: true,
    workspaceIds: []
  }))
  client.receive(ready)
  expect(client.receive({ type: 'fence', round: { ...round, connectionId: 'other' } })).toBeNull()
  client.receive({ type: 'fence', round })
  const newer = { ...fence, token: '55555555-5555-4555-8555-555555555555' }
  client.receive({ type: 'fence', round: { ...round, fence: newer } })
  client.disconnect()
  const next = '66666666-6666-4666-8666-666666666666'
  client.receive({ ...ready, channelNonce: next })
  client.receive({ type: 'settled', channelNonce, fence: newer, proof: 'old-channel' })
  client.receive({ type: 'settled', channelNonce: next, fence, proof: 'native-cancelled-old' })
  expect(client.canSelect('target')).toBe(false)
  client.receive({
    type: 'settled',
    channelNonce: next,
    fence: {
      ...newer,
      resource: { ...newer.resource, generation: 'foreign' }
    },
    proof: 'foreign-binding'
  })
  expect(client.canSelect('target')).toBe(false)
  client.receive({ type: 'settled', channelNonce: next, fence: newer, proof: 'native-confirmed' })
  expect(client.canSelect('target')).toBe(true)
})

it('never acknowledges absence after inventory failure or overflow', () => {
  for (const snapshot of [
    () => {
      throw new Error('unavailable')
    },
    () => ({ complete: false, workspaceIds: [] }),
    () => ({ complete: true, workspaceIds: Array.from({ length: 65 }, (_, i) => String(i)) })
  ]) {
    const client = new WorktreeSelectionClient(incarnation, snapshot)
    client.receive(ready)
    expect(client.receive({ type: 'fence', round })?.disposition).toBe('unknown')
    expect(client.canSelect('target')).toBe(false)
  }
})
