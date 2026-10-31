import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  fixtureRoot,
  WorktreeCustodyAuthority,
  WorktreeCustodyFileJournal,
  BASE,
  setup,
  completeObservation
} from './worktree-custody-fixture.mjs'

test('optional claims read/write failures do not create effect state or block default admissions', () => {
  for (const reason of ['corrupt', 'EROFS', 'ENOSPC', 'EEXIST', 'custody_journal_full']) {
    let writes = 0
    const effects = {
      read: () => ({ records: [], receipts: [] }),
      write: () => {
        writes++
        throw new Error('must not write effects')
      }
    }
    const claims = {
      read: () => {
        throw new Error(reason)
      },
      write: () => {
        throw new Error(reason)
      }
    }
    const authority = new WorktreeCustodyAuthority(effects, 'optional', Date.now, claims)
    authority.claim(BASE, 'default-claim')
    authority.release('default-claim', 'owning-release')
    authority.admit(BASE.worktreeId, BASE.path)()
    authority.checkAdmission('other', '/unrelated')
    assert.equal(writes, 0)
    assert.equal(authority.complete, false)
    assert.equal(authority.supported, false)
  }
})

test('failed optional writes after opt-in disable capture without poisoning existing Starts', async () => {
  const f = setup({
    beforeWrite: () => {
      throw new Error('ENOSPC')
    }
  })
  assert.equal(f.authority.complete, false)
  f.authority.admit(BASE.worktreeId, BASE.path)()
  f.authority.claim({ ...BASE, worktreeId: 'other', path: '/unrelated' }, 'unrelated')
  await assert.rejects(
    f.authority.capture(f.resource),
    /producer_release_unproven|coverage_unsupported/
  )
  assert.equal(f.effects(), 0)
})

test('prior-incarnation cancellation requires exact owning recovery proof and persists it', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const restarted = new WorktreeCustodyAuthority(
    f.journal,
    'recovery-authority',
    () => 100_000,
    f.claimsJournal
  )
  restarted.installCoverage(BASE.owner, {
    ...f.coverage,
    recoverFence: async (held) => ({
      fence: { ...held, token: 'other' },
      recovered: true,
      proof: 'wrong-token'
    })
  })
  await assert.rejects(restarted.cancel(fence), /recovery_unproven/)
  assert.throws(() => restarted.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  const recovered = new WorktreeCustodyAuthority(
    f.journal,
    'owning-recovery',
    () => 100_000,
    f.claimsJournal
  )
  recovered.installCoverage(BASE.owner, {
    ...f.coverage,
    recoverFence: async (held) => ({
      fence: held,
      recovered: true,
      proof: 'owning-recovery-settled-all-grants'
    })
  })
  await recovered.cancel(fence)
  const again = new WorktreeCustodyAuthority(
    f.journal,
    'after-recovery',
    () => 100_000,
    f.claimsJournal
  )
  again.checkAdmission(BASE.worktreeId, BASE.path)
  assert.equal(f.journal.read().records[0].recovery.proof, 'owning-recovery-settled-all-grants')
  assert.equal(f.effects(), 0)
})

for (const failure of ['EEXIST', 'ENOSPC', 'EROFS']) {
  test(`a failed ${failure} revocation stays unknown after restart without relying on lock presence`, async () => {
    const directory = mkdtempSync(join(fixtureRoot, `failed-revoke-${failure}-`))
    const effectPath = join(directory, 'effects')
    const claimPath = join(directory, 'claims')
    const claims = new WorktreeCustodyFileJournal(claimPath)
    let fail = false
    const a = new WorktreeCustodyAuthority(
      new WorktreeCustodyFileJournal(effectPath),
      'before-failed-write',
      Date.now,
      {
        read: () => claims.read(),
        write: (state) => {
          if (fail && failure !== 'EEXIST') {
            throw Object.assign(new Error(failure), { code: failure })
          }
          claims.write(state)
        }
      }
    )
    const coverage = {
      observe: async (resource) => completeObservation(resource),
      acquire: async () => ({ check: () => true, release: () => {} }),
      retire: async () => {},
      reconcile: async (outcome) => ({
        resource: outcome.resource,
        key: outcome.key,
        confirmed: false,
        proof: null
      }),
      recoverFence: async (fence) => ({ fence, recovered: false, proof: null })
    }
    a.installCoverage(BASE.owner, coverage)
    const resource = a.claim(BASE, 'failed-revocation')
    a.release('failed-revocation', 'committed-owning-release')
    if (failure === 'EEXIST') {
      writeFileSync(join(claimPath, 'writer.lock'), 'leftover', { mode: 0o600 })
    }
    fail = true
    a.admit(BASE.worktreeId, BASE.path)()
    assert.equal(a.complete, false)
    const disk = new WorktreeCustodyFileJournal(claimPath).read().records[0]
    assert.equal(disk.revoked, false)
    assert.equal(existsSync(join(claimPath, 'writer.lock')), failure === 'EEXIST')
    const b = new WorktreeCustodyAuthority(
      new WorktreeCustodyFileJournal(effectPath),
      'after-failed-write',
      Date.now,
      new WorktreeCustodyFileJournal(claimPath)
    )
    b.installCoverage(BASE.owner, coverage)
    assert.equal((await b.observe(resource)).disposition, 'unknown')
    b.release('failed-revocation', 'committed-owning-release')
    assert.equal((await b.observe(resource)).disposition, 'unknown')
    await assert.rejects(b.capture(resource), /producer_release_unproven/)
    b.admit(BASE.worktreeId, BASE.path)()
    if (failure !== 'EEXIST') {
      const fresh = b.claim(
        { ...BASE, path: '/unrelated-current', worktreeId: 'repo::/unrelated-current' },
        'fresh'
      )
      b.release('fresh', 'fresh-committed-release')
      const fence = await b.capture(fresh)
      await b.cancel(fence)
    }
  })
}

test('only a bound owning producer/consumer proof renews a historical release epoch', async () => {
  const f = setup()
  for (const substitute of [
    'resource',
    'claim',
    'epoch',
    'old-epoch',
    'release-proof',
    'unconfirmed',
    'oversized',
    'nonboolean',
    'nonstring-proof'
  ]) {
    const b = new WorktreeCustodyAuthority(
      f.journal,
      `epoch-${substitute}`,
      () => 100_000,
      f.claimsJournal
    )
    b.installCoverage(BASE.owner, {
      ...f.coverage,
      recoverRelease: async (release) => ({
        release: {
          ...release,
          ...(substitute === 'resource'
            ? { resource: { ...release.resource, instanceId: 'other' } }
            : {}),
          ...(substitute === 'claim' ? { claim: 'dispatch:other' } : {}),
          ...(substitute === 'epoch' ? { authorityId: 'other-epoch' } : {}),
          ...(substitute === 'old-epoch' ? { releaseEpoch: 'other-old-epoch' } : {}),
          ...(substitute === 'release-proof' ? { releaseProof: 'other-release-proof' } : {})
        },
        confirmed: substitute === 'nonboolean' ? 'true' : substitute !== 'unconfirmed',
        proof:
          substitute === 'oversized'
            ? 'x'.repeat(8193)
            : substitute === 'nonstring-proof'
              ? 7
              : 'substituted-owning-proof'
      })
    })
    assert.equal((await b.observe(f.resource)).disposition, 'unknown')
    await assert.rejects(b.capture(f.resource), /producer_release_unproven/)
  }
  const b = new WorktreeCustodyAuthority(
    f.journal,
    'verified-recovery-epoch',
    () => 100_000,
    f.claimsJournal
  )
  b.installCoverage(BASE.owner, {
    ...f.coverage,
    recoverRelease: async (release) => ({
      release,
      confirmed: true,
      proof: 'owning-durable-consumer-history-and-producer-release'
    })
  })
  assert.equal((await b.observe(f.resource)).disposition, 'released')
  assert.equal(f.claimsJournal.read().records[0].releaseEpoch, 'verified-recovery-epoch')
  assert.equal(
    f.claimsJournal.read().records[0].releaseRecoveryProof,
    'owning-durable-consumer-history-and-producer-release'
  )
  const fence = await b.capture(f.resource)
  await b.cancel(fence)
  const c = new WorktreeCustodyAuthority(
    f.journal,
    'next-incarnation',
    () => 100_000,
    f.claimsJournal
  )
  c.installCoverage(BASE.owner, f.coverage)
  assert.equal((await c.observe(f.resource)).disposition, 'unknown')
  c.checkAdmission(BASE.worktreeId, BASE.path)
})

test('capacity never evicts a revoked generation or its unknown path aggregate', async () => {
  const f = setup({ coverage: false })
  f.authority.admit(BASE.worktreeId, BASE.path)()
  const sibling = f.authority.claim({ ...BASE, task: 'sibling' }, 'sibling')
  f.authority.release('sibling', 'sibling-release')
  for (let i = 0; i < 2046; i++) {
    f.authority.claim({ ...BASE, path: `/held-${i}`, worktreeId: `repo::/held-${i}` }, `held-${i}`)
  }
  assert.throws(
    () =>
      f.authority.claim({ ...BASE, path: '/overflow', worktreeId: 'repo::/overflow' }, 'overflow'),
    /claims_full/
  )
  assert.notEqual(f.authority.claimedResource('dispatch:1'), null)
  assert.notEqual(f.authority.claimedResource('sibling'), null)
  assert.equal((await f.authority.observe(sibling)).disposition, 'unknown')
  await assert.rejects(f.authority.capture(sibling), /producer_release_unproven/)
})
