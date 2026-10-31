import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  contract,
  WorktreeCustodyAuthority,
  BASE,
  KEY,
  setup
} from './worktree-custody-fixture.mjs'

test('native release and registered coverage are independently mandatory', async () => {
  const missing = setup({ coverage: false })
  assert.equal((await missing.authority.observe(missing.resource)).disposition, 'released')
  assert.equal(missing.authority.supported, false)
  await assert.rejects(missing.authority.capture(missing.resource), /coverage_unsupported/)
  const held = setup({ release: false })
  await assert.rejects(held.authority.capture(held.resource), /producer_release_unproven/)
  assert.equal(held.effects(), 0)
  assert.equal(held.grantReleased(), 0)
})

for (const domain of contract.WORKTREE_CUSTODY_DOMAINS) {
  for (const mutation of [{ complete: false }, { active: true }, { held: true }, { proof: null }]) {
    test(`${domain} refuses incomplete, active, held or proofless consumers: ${JSON.stringify(mutation)}`, async () => {
      const fixture = setup({
        observe: (observation) => ({
          ...observation,
          domains: observation.domains.map((entry) =>
            entry.domain === domain ? { ...entry, ...mutation } : entry
          )
        })
      })
      await assert.rejects(fixture.authority.capture(fixture.resource), /custody_refused/)
      assert.equal(fixture.effects(), 0)
    })
  }
}

test('stale, future, duplicate and missing observations refuse before dispatch', async () => {
  for (const mutation of [
    (o) => ({ ...o, observedAt: o.observedAt - 30_001 }),
    (o) => ({ ...o, observedAt: o.observedAt + 1 }),
    (o) => ({ ...o, observedAt: Number.NaN }),
    (o) => ({ ...o, domains: [...o.domains, o.domains[0]] }),
    (o) => ({ ...o, domains: o.domains.slice(1) })
  ]) {
    const f = setup({ observe: mutation })
    await assert.rejects(f.authority.capture(f.resource), /custody_refused/)
    assert.equal(f.effects(), 0)
  }
})

test('resource substitutions cannot capture a grant', async () => {
  const f = setup()
  for (const [field, value] of Object.entries({
    path: '/elsewhere',
    instanceId: 'replacement',
    generation: 'new',
    task: 'foreign',
    hostId: 'ssh:other'
  })) {
    await assert.rejects(f.authority.capture({ ...f.resource, [field]: value }), /resource_unknown/)
  }
})

test('admission before release remains held; reopening after release revokes that generation', async () => {
  const f = setup({ release: false })
  const finish = f.authority.admit(BASE.worktreeId, `${BASE.path}/child`)
  f.authority.release('dispatch:1', 'native-release:1')
  await assert.rejects(f.authority.capture(f.resource), /admission_active/)
  finish()
  const fence = await f.authority.capture(f.resource)
  assert.throws(() => f.authority.admit(BASE.worktreeId, BASE.path), /custody_fenced/)
  assert.throws(() => f.authority.admit('nested::other', `${BASE.path}/child`), /custody_fenced/)
  await f.authority.cancel(fence)
  f.authority.admit(BASE.worktreeId, BASE.path)()
  assert.equal((await f.authority.observe(f.resource)).disposition, 'unknown')
  await assert.rejects(f.authority.capture(f.resource), /producer_release_unproven/)
  assert.throws(() => f.authority.release('dispatch:1', 'native-release:1'), /reopened/)
})

test('capture closes admission before an asynchronous provider fence and refuses competing captures', async () => {
  let acquired
  const waiting = new Promise((resolve) => {
    acquired = resolve
  })
  const f = setup({ acquire: () => waiting })
  const capture = f.authority.capture(f.resource)
  assert.throws(() => f.authority.admit(BASE.worktreeId, BASE.path), /custody_fenced/)
  await assert.rejects(f.authority.capture(f.resource), /custody_fenced/)
  acquired()
  const fence = await capture
  await f.authority.cancel(fence)
})

test('expired, forged and prior-incarnation fences never reach the effect', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  for (const forged of [
    { ...fence, token: 'forged' },
    { ...fence, authorityId: 'other' }
  ]) {
    await assert.rejects(f.authority.retire(forged, KEY), /fence_invalid/)
  }
  f.advance(30_001)
  await assert.rejects(f.authority.retire(fence, KEY), /fence_invalid/)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'authority-2')
  await assert.rejects(restarted.cancel(fence), /coverage_unsupported/)
  assert.throws(() => restarted.admit(BASE.worktreeId, BASE.path), /custody_fenced/)
  assert.equal(f.effects(), 0)
})

test('multiple producer claims expose only the latest generation without discarding history', () => {
  const f = setup()
  const newer = f.authority.claim({ ...BASE, task: 'task-2' }, 'dispatch:2')
  assert.deepEqual(f.authority.resources(), [newer])
  assert.equal(f.claimsJournal.read().records.length, 2)
})

test('generations on an overlapping path share one fence and one effect', async () => {
  const f = setup()
  const newer = f.authority.claim({ ...BASE, task: 'task-2' }, 'dispatch:2')
  f.authority.release('dispatch:2', 'release-2')
  const first = f.authority.capture(f.resource)
  await assert.rejects(f.authority.capture(newer), /custody_fenced/)
  const fence = await first
  const retiring = f.authority.retire(fence, KEY)
  await assert.rejects(f.authority.capture(newer), /custody_fenced/)
  assert.equal((await retiring).state, 'retired')
  await assert.rejects(f.authority.capture(newer), /material_retired/)
  assert.equal(f.effects(), 1)
})

test('the visible latest generation cannot hide an older held generation', async () => {
  const f = setup({ release: false })
  const newer = f.authority.claim({ ...BASE, task: 'task-2' }, 'dispatch:2')
  f.authority.release('dispatch:2', 'release-2')
  assert.deepEqual(f.authority.resources(), [newer])
  assert.equal((await f.authority.observe(newer)).disposition, 'held')
  await assert.rejects(f.authority.capture(newer), /producer_release_unproven/)
  assert.equal(f.effects(), 0)
})

test('read-only fence lookups preserve release receipts and perform zero writes', async () => {
  const f = setup()
  const before = f.writes()
  for (let i = 0; i < 10; i++) {
    f.authority.checkAdmission(BASE.worktreeId, BASE.path)
  }
  assert.equal(f.writes(), before)
  assert.equal((await f.authority.observe(f.resource)).disposition, 'released')
  const fence = await f.authority.capture(f.resource)
  assert.throws(() => f.authority.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  await f.authority.cancel(fence)
})

test('observation claim is the native stored dispatch binding and cannot be supplied by coverage', async () => {
  const f = setup({ observe: (observation) => ({ ...observation, claim: 'dispatch:forged' }) })
  const observation = await f.authority.observe(f.resource)
  assert.equal(observation.claim, 'dispatch:1')
  assert.throws(
    () => f.authority.claim({ ...BASE, instanceId: 'other-instance' }, 'dispatch:1'),
    /binding_changed/
  )
  assert.equal(f.effects(), 0)
})
