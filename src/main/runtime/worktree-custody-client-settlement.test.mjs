import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  fixtureRoot,
  moduleFromSource,
  setup,
  WorktreeCustodyAuthority,
  WorktreeCustodyFileJournal,
  KEY
} from './worktree-custody-fixture.mjs'

const { WorktreeCustodyFileJournal: V4Reader } = await moduleFromSource(
  'v4-journal.mjs',
  './worktree-custody-v4-reader.test-fixture.ts',
  {
    '../../shared/worktree/custody': './custody.mjs',
    './worktree-custody-epoch-seal': './epoch-seal.mjs'
  }
)

test('only the exact durably cancelled native fence releases a client gate, including restart', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  assert.equal(f.authority.clientFenceSettlement(fence), null)
  await f.authority.cancel(fence)
  assert.match(f.authority.clientFenceSettlement(fence), /^native-client-cancel:/)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'new-incarnation')
  assert.equal(restarted.clientFenceSettlement(fence), f.authority.clientFenceSettlement(fence))
  for (const changed of [
    { ...fence, capturedAt: fence.capturedAt + 1 },
    { ...fence, authorityId: 'foreign' },
    { ...fence, resource: { ...fence.resource, generation: 'foreign' } }
  ]) {
    assert.equal(restarted.clientFenceSettlement(changed), null)
  }
})

test('a failed cancellation commit cannot release any client admission', async () => {
  let fail = false
  const f = setup({
    beforeWrite: () => {
      if (fail) {
        throw new Error('ENOSPC')
      }
    }
  })
  const fence = await f.authority.capture(f.resource)
  fail = true
  await assert.rejects(f.authority.cancel(fence), /ENOSPC/)
  assert.equal(f.authority.clientFenceSettlement(fence), null)
})

test('missed cancellation releases survive later captures, final retirement and restart', async () => {
  const f = setup()
  const first = await f.authority.capture(f.resource)
  await f.authority.cancel(first)
  const expected = f.authority.clientFenceSettlement(first)
  const second = await f.authority.capture(f.resource)
  await f.authority.cancel(second)
  const third = await f.authority.capture(f.resource)
  await f.authority.retire(third, KEY)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'after-terminal')
  assert.equal(restarted.clientFenceSettlement(first), expected)
  assert.match(restarted.clientFenceSettlement(second), /^native-client-cancel:/)
  assert.match(restarted.clientFenceSettlement(third), /^native-client-result:/)
})

test('terminal authority receipt binds full fence and version5 rejects the real frozen version4 reader', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  await f.authority.retire(fence, KEY)
  assert.match(f.authority.clientFenceSettlement(fence), /^native-client-result:/)
  assert.equal(f.authority.clientFenceSettlement({ ...fence, token: 'newer' }), null)
  const directory = join(fixtureRoot, 'client-version5')
  const journal = new WorktreeCustodyFileJournal(directory)
  journal.read()
  journal.write(f.journal.read())
  assert.throws(() => new V4Reader(directory).read(), /custody_journal_invalid/)
  const restarted = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(directory),
    'current-reader'
  )
  assert.equal(restarted.clientFenceSettlement(fence), f.authority.clientFenceSettlement(fence))
})
