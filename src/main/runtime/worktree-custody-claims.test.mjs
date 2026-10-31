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
  completeObservation,
  nativePorts,
  KEY,
  NativeRetirementResults
} from './worktree-custody-fixture.mjs'
import { providerFixture, providerCheckout } from './worktree-custody-native-fixture.mjs'

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

test('a crashed capture is recovered only by a successor profile lock and proven holder exit', async () => {
  const checkout = providerCheckout('crashed-capture')
  const prior = {
    pid: 41,
    startedAtMs: null,
    linuxStartTicks: '100',
    bootId: 'boot-1',
    nonce: 'lock-prior',
    identity: '1000',
    machineIdentity: 'machine-1'
  }
  let effects = { records: [], receipts: [] }
  let claims = { records: [], receipts: [] }
  const journal = {
    read: () => structuredClone(effects),
    write: (s) => (effects = structuredClone(s))
  }
  const claimsJournal = {
    read: () => structuredClone(claims),
    write: (s) => (claims = structuredClone(s))
  }
  const shared = { journal, claims: claimsJournal }
  const crashed = await providerFixture(checkout, {
    ...shared,
    authorityId: 'a-prior',
    witness: () => prior
  })
  crashed.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const fence = await crashed.authority.capture(crashed.resource)
  assert.equal(effects.records[0].fenceOwner.nonce, 'lock-prior')
  crashed.sqlite.close()
  shared.resource = crashed.resource
  // The capturing process died with its grant; only the durable fence and witness remain.
  let exited = false
  const current = { ...prior, pid: 77, linuxStartTicks: '900', nonce: 'lock-current' }
  for (const [name, lock, reason] of [
    ['lock unavailable', { current: () => null, exited: () => true }],
    ['holder not proven exited', { current: () => current, exited: () => exited }],
    [
      'other machine',
      { current: () => ({ ...current, machineIdentity: 'm2' }), exited: () => true }
    ],
    ['same lock nonce', { current: () => ({ ...current, nonce: prior.nonce }), exited: () => true }]
  ]) {
    const f = await providerFixture(checkout, {
      ...shared,
      authorityId: `a-${String(name)}`,
      profileLock: lock
    })
    await assert.rejects(
      f.authority.cancel(fence),
      /custody_fence_recovery_unproven/,
      name ?? reason
    )
    assert.throws(() => f.authority.checkAdmission(f.resource.worktreeId, checkout), /fenced/)
    f.sqlite.close()
  }
  exited = true
  const successor = await providerFixture(checkout, {
    ...shared,
    authorityId: 'a-successor',
    profileLock: {
      current: () => current,
      exited: (owner) => owner.nonce === 'lock-prior' && exited
    }
  })
  await successor.authority.cancel(fence)
  successor.authority.checkAdmission(successor.resource.worktreeId, checkout)
  assert.equal(effects.records[0].fenceOwner, undefined)
  assert.equal(
    effects.records[0].recovery.proof,
    'profile-lock-successor:lock-current:exited:lock-prior:41'
  )
  successor.sqlite.close()

  // A fence captured without a held lock carries no witness, so no successor can settle it.
  const unwitnessed = providerCheckout('unwitnessed-capture')
  const before = await providerFixture(unwitnessed, { authorityId: 'a-no-lock' })
  before.authority.release(`dispatch:${unwitnessed}`, `native-worker-release:${unwitnessed}`)
  const bare = await before.authority.capture(before.resource)
  assert.equal((await before.provider.recoverFence(bare, null)).recovered, false)
  before.sqlite.close()
})

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

test('owning recovery cannot renew an epoch when its durability write fails', async () => {
  const f = setup()
  const successor = new WorktreeCustodyAuthority(f.journal, 'failed-recovery', () => 100_000, {
    read: f.claimsJournal.read,
    write: () => {
      throw new Error('ENOSPC')
    }
  })
  successor.installCoverage(BASE.owner, {
    ...f.coverage,
    recoverRelease: async (release) => ({ release, confirmed: true, proof: 'owning-history' })
  })
  assert.equal((await successor.observe(f.resource)).disposition, 'unknown')
  assert.equal(successor.complete, false)
  assert.notEqual(f.claimsJournal.read().records[0].releaseEpoch, 'failed-recovery')
  successor.admit('other', '/unrelated')()
  await assert.rejects(
    successor.capture(f.resource),
    /producer_release_unproven|coverage_unsupported/
  )
})

test('clean epoch seals require native admission closure, drained reservations and a healthy owner', async () => {
  const f = setup()
  let claims = { records: [], receipts: [] }
  const owner = {
    pid: 42,
    startedAtMs: 1,
    identity: 'fixture-owner',
    machineIdentity: 'fixture-machine',
    nonce: 'fixture-lock'
  }
  const authority = new WorktreeCustodyAuthority(
    { read: () => ({ records: [], receipts: [] }), write: () => {} },
    'clean-epoch',
    () => 100_000,
    {
      read: () => structuredClone(claims),
      write: (state) => {
        claims = structuredClone(state)
      }
    },
    () => owner
  )
  authority.installCoverage(BASE.owner, f.coverage)
  const resource = authority.claim(BASE, 'sealed-claim')
  authority.release('sealed-claim', 'native-release')
  const release = authority.admit('unrelated', '/unrelated', false)
  assert.equal(authority.sealClosedEpoch(), false)
  authority.closeAdmissions()
  assert.equal(authority.sealClosedEpoch(), false)
  assert.throws(() => authority.admit('other', '/other'), /admissions_closed/)
  release()
  assert.equal(authority.sealClosedEpoch(), true)
  assert.equal(claims.epochSeal.authorityId, 'clean-epoch')
  assert.equal(claims.records[0].releaseProof, 'native-release')
  const successor = new WorktreeCustodyAuthority(
    { read: () => ({ records: [], receipts: [] }), write: () => {} },
    'next-epoch',
    () => 100_000,
    { read: () => structuredClone(claims), write: () => {} }
  )
  successor.installCoverage(BASE.owner, f.coverage)
  assert.equal((await successor.observe(resource)).disposition, 'unknown')
  successor.admit('unrelated', '/unrelated')()
})

/** A custody effects journal whose writes fail while `failing` returns true for the state. */
function flakyJournal() {
  let state = { records: [], receipts: [] }
  const control = { failing: () => false }
  return {
    control,
    journal: {
      read: () => structuredClone(state),
      write: (next) => {
        if (control.failing(next)) {
          throw new Error('custody receipt write failed')
        }
        state = structuredClone(next)
      }
    }
  }
}

async function retiredButReceiptLost(name, options = {}) {
  const checkout = providerCheckout(name)
  const { journal, control } = flakyJournal()
  const claims = { read: () => ({ records: [], receipts: [] }), write: () => {} }
  const f = await providerFixture(checkout, { journal, claims, authorityId: `${name}-first` })
  f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const fence = await f.authority.capture(f.resource)
  let removals = 0
  nativePorts.setRemove(async () => {
    removals++
    if (options.gitThrows) {
      throw new Error('git outcome lost')
    }
    return {}
  })
  const receipts = nativePorts.nativeResults().receipts.length
  nativePorts.setResultFailure((state) => options.resultFails && state.receipts.length > receipts)
  // The custody terminal receipt is lost after the native effect returns.
  control.failing = (state) => state.receipts.length > 0
  const first = await f.authority.retire(fence, KEY)
  nativePorts.setResultFailure(() => false)
  control.failing = () => false
  f.sqlite.close()
  const restarted = await providerFixture(checkout, {
    journal,
    claims,
    authorityId: `${name}-restarted`,
    resource: f.resource
  })
  return { first, restarted, removals: () => removals, checkout, resource: f.resource }
}

test('a committed native removal result reconciles a lost custody receipt without resending', async () => {
  const lost = await retiredButReceiptLost('result-reconcile')
  assert.equal(lost.first.state, 'unknown')
  assert.equal(lost.first.reason, 'native_outcome_commit_pending')
  const native = nativePorts.nativeResults()
  assert.equal(native.records.length, 0, 'the receipt replaced its intent')
  assert.equal(native.receipts.filter((receipt) => receipt.state === 'retired').length, 1)
  const reconciled = await lost.restarted.authority.reconcile(lost.resource, KEY)
  assert.equal(reconciled.state, 'retired')
  assert.equal(reconciled.reason, 'native_outcome_confirmed')
  assert.equal(lost.removals(), 1)
  // The custody receipt is now durable: replay needs no native result and never resends.
  assert.equal(
    (await lost.restarted.authority.retire({ resource: lost.resource }, KEY)).state,
    'retired'
  )
  assert.equal(lost.removals(), 1)
  lost.restarted.sqlite.close()
})

test('intent without a committed removal result stays unknown and never resends', async () => {
  for (const [name, options] of [
    ['git-outcome-lost', { gitThrows: true }],
    ['result-write-lost', { resultFails: true }]
  ]) {
    const lost = await retiredButReceiptLost(name, options)
    assert.equal(lost.first.state, 'unknown', name)
    const reconciled = await lost.restarted.authority.reconcile(lost.resource, KEY)
    assert.equal(reconciled.state, 'unknown', name)
    assert.equal(reconciled.reason, 'native_outcome_unproven', name)
    assert.equal(lost.removals(), 1, name)
    // Another key cannot borrow this generation's dispatched outcome.
    await assert.rejects(
      lost.restarted.authority.reconcile(lost.resource, 'another_key_000001'),
      /custody_key_binding_changed/
    )
    lost.restarted.sqlite.close()
  }
})

test('an intent that cannot be made durable refuses before Git', async () => {
  const checkout = providerCheckout('intent-unwritable')
  const f = await providerFixture(checkout)
  f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const fence = await f.authority.capture(f.resource)
  nativePorts.setRemove(() => assert.fail('Git must not run without a durable intent'))
  nativePorts.setResultFailure((state) => state.records.length > 0)
  try {
    const outcome = await f.authority.retire(fence, KEY)
    assert.equal(outcome.state, 'refused')
    assert.equal(outcome.reason, 'custody_pre_effect_refused')
  } finally {
    nativePorts.setResultFailure(() => false)
  }
  assert.equal(existsSync(checkout), true)
  f.sqlite.close()
})

test('same-key results for two resources stay independent in the real result journal', () => {
  const directory = join(mkdtempSync(join(fixtureRoot, 'native-results-')), 'results')
  const a = { ...BASE, path: '/fixture/a', worktreeId: 'repo::/fixture/a', generation: 'gen-a' }
  const b = { ...BASE, path: '/fixture/b', worktreeId: 'repo::/fixture/b', generation: 'gen-b' }
  const outcome = (resource) => ({
    resource,
    key: KEY,
    state: 'unknown',
    recordedAt: 1,
    reason: null
  })
  const results = new NativeRetirementResults(new WorktreeCustodyFileJournal(directory), BASE.owner)
  results.recordIntent(a, KEY)
  results.recordIntent(b, KEY)
  results.recordRemoved(a, KEY)
  // Completing A leaves B's pending intent, and B has no removal evidence yet.
  const reread = new WorktreeCustodyFileJournal(directory).read()
  assert.equal(reread.records.length, 1)
  assert.equal(reread.records[0].resource.generation, 'gen-b')
  const restarted = new NativeRetirementResults(
    new WorktreeCustodyFileJournal(directory),
    BASE.owner
  )
  assert.equal(restarted.confirmed(outcome(a)).confirmed, true)
  assert.equal(restarted.confirmed(outcome(b)), null)
  restarted.recordRemoved(b, KEY)
  const final = new NativeRetirementResults(new WorktreeCustodyFileJournal(directory), BASE.owner)
  assert.equal(final.confirmed(outcome(a)).confirmed, true)
  assert.equal(final.confirmed(outcome(b)).confirmed, true)
  assert.notEqual(final.confirmed(outcome(a)).proof, final.confirmed(outcome(b)).proof)
  // Another owner, generation or key never reads these removals.
  assert.equal(
    new NativeRetirementResults(new WorktreeCustodyFileJournal(directory), 'other').confirmed(
      outcome(a)
    ),
    null
  )
  assert.equal(final.confirmed(outcome({ ...a, generation: 'gen-c' })), null)
  assert.equal(final.confirmed({ ...outcome(a), key: 'another_key_000001' }), null)
  assert.equal(new WorktreeCustodyFileJournal(directory).read().records.length, 0)
})
