import assert from 'node:assert/strict'
import { test } from 'vitest'
import { moduleFromSource, setup } from './worktree-custody-fixture.mjs'
import './worktree-custody-runtime-fixture.mjs'

await moduleFromSource('selection-rounds.mjs', './worktree-custody-selection-rounds.ts', {
  '../../shared/worktree/custody': './custody.mjs'
})
const { WorktreeCustodySelections } = await moduleFromSource(
  'selections.mjs',
  './worktree-custody-selections.ts',
  {
    './worktree-custody-runtime': './native-ports.mjs',
    '../../shared/app-environment': './runtime-ports.mjs',
    './worktree-custody-selection-rounds': './selection-rounds.mjs',
    '../../shared/cross-platform-path': './cross-platform-path.mjs'
  }
)
const { WorktreeSelectionClient } = await moduleFromSource(
  'selection-client.mjs',
  '../../shared/worktree/custody-selection-client.ts',
  {
    './custody': './custody.mjs'
  }
)
const incarnation = '11111111-1111-4111-8111-111111111111'

function connected(inventory, options = {}) {
  const id = options.id ?? 'phone'
  const client = new WorktreeSelectionClient(incarnation, () => ({
    complete: options.complete ?? true,
    workspaceIds: options.workspaceIds ?? []
  }))
  const close = inventory.open(id)
  const frames = []
  inventory.watch(id, incarnation, (frame) => {
    frames.push(frame)
    const ack = client.receive(frame)
    if (ack && options.ack !== false) {
      options.beforeAck?.(ack)
      inventory.acknowledge(id, ack)
    }
  })
  inventory.report(id, options.workspaceIds ?? [], 'view', options.complete ?? true)
  return { client, close, frames }
}

test('owning native cancellation is the only release after a client closed its target admission', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const inventory = new WorktreeCustodySelections(
    () => () => {},
    (value) => f.authority.clientFenceSettlement(value)
  )
  const { client } = connected(inventory)
  const grant = await inventory.acquire(fence)
  assert.equal(grant.check(), true)
  assert.equal(client.canSelect(f.resource.worktreeId), false)
  assert.equal(client.canSelect('other-workspace'), true)
  assert.throws(() => grant.release(), /settlement_unproven/)
  assert.equal(client.canSelect(f.resource.worktreeId), false)
  await f.authority.cancel(fence)
  grant.release()
  assert.equal(client.canSelect(f.resource.worktreeId), true)
  assert.equal(grant.check(), false)
})

test('ACK substitutes for another connection, incarnation, nonce or full native fence are rejected', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const inventory = new WorktreeCustodySelections(() => () => {})
  const invalid = []
  connected(inventory, {
    beforeAck: (ack) => {
      for (const changed of [
        { ...ack, connectionId: 'other' },
        { ...ack, clientIncarnation: '22222222-2222-4222-8222-222222222222' },
        { ...ack, nonce: '22222222-2222-4222-8222-222222222222' },
        { ...ack, fence: { ...ack.fence, expiresAt: ack.fence.expiresAt + 1 } },
        {
          ...ack,
          fence: { ...ack.fence, resource: { ...ack.fence.resource, generation: 'other' } }
        }
      ]) {
        assert.throws(() => inventory.acknowledge('phone', changed), /ack_binding_changed/)
        invalid.push(changed)
      }
    }
  })
  const grant = await inventory.acquire(fence)
  assert.equal(invalid.length, 5)
  assert.equal(grant.check(), true)
})

test('background or folder consumers refuse without unmounting; incomplete and legacy peers hold', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  for (const mounted of [f.resource.worktreeId, 'folder:background']) {
    const inventory = new WorktreeCustodySelections(() => () => {})
    const view = connected(inventory)
    const release = view.client.mount(mounted)
    const target = { ...fence, resource: { ...f.resource, worktreeId: mounted } }
    await assert.rejects(inventory.acquire(target), /selection_held/)
    assert.equal(view.client.hasMounted(mounted), true)
    release()
  }
  const legacy = new WorktreeCustodySelections(() => () => {})
  legacy.open('legacy')
  legacy.report('legacy', [])
  await assert.rejects(legacy.acquire(fence), /inventory_unknown/)
  const incomplete = new WorktreeCustodySelections(() => () => {})
  connected(incomplete, { complete: false })
  await assert.rejects(incomplete.acquire(fence), /inventory_unknown/)
})

test('late connect, disconnect/reopen and incomplete report invalidate cached grants', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const inventory = new WorktreeCustodySelections(() => () => {})
  const first = connected(inventory)
  const grant = await inventory.acquire(fence)
  const closeLate = inventory.open('late')
  closeLate()
  assert.equal(grant.check(), false)
  first.close()
  connected(inventory)
  first.close()
  const replacement = await inventory.acquire(fence)
  assert.equal(replacement.check(), true)
  inventory.report('phone', [], 'view', false)
  assert.equal(replacement.check(), false)
})

test(
  'a nonresponding live peer times out and disconnect releases neither its cached target nor native proof',
  { timeout: 6500 },
  async () => {
    const f = setup()
    const fence = await f.authority.capture(f.resource)
    const inventory = new WorktreeCustodySelections(() => () => {})
    const view = connected(inventory, { ack: false })
    await assert.rejects(inventory.acquire(fence), /ack_timeout/)
    view.close()
    assert.equal(view.client.canSelect(f.resource.worktreeId), false)
  }
)

test('headless absence is a live declaration scoped to its own connection', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const inventory = new WorktreeCustodySelections(() => () => {})
  inventory.open('cli')
  inventory.report('cli', [], 'headless')
  assert.equal((await inventory.acquire(fence)).check(), true)
  inventory.open('nonreporting-client')
  await assert.rejects(inventory.acquire(fence), /inventory_unknown/)
})
