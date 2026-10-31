import { nativePorts, nativeFixture } from './worktree-custody-native-fixture.mjs'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  symlinkSync
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  fixtureRoot,
  WorktreeCustodyAuthority,
  WorktreeCustodyFileJournal,
  BASE,
  KEY,
  setup
} from './worktree-custody-fixture.mjs'

test('one durable dispatch retires a fixture exactly once and preserves historical key lookup', async () => {
  const source = join(fixtureRoot, 'checkout-once')
  const retained = join(fixtureRoot, 'retained-once')
  writeFileSync(source, 'preserved fixture material')
  const f = setup({ effect: () => renameSync(source, retained) })
  const fence = await f.authority.capture(f.resource)
  const result = await f.authority.retire(fence, KEY)
  assert.equal(result.state, 'retired')
  assert.equal((await f.authority.retire(fence, KEY)).state, 'retired')
  assert.equal(f.effects(), 1)
  assert.equal(readFileSync(retained, 'utf8'), 'preserved fixture material')
  const restarted = new WorktreeCustodyAuthority(f.journal, 'authority-2')
  assert.equal((await restarted.reconcile(f.resource, KEY)).state, 'retired')
  assert.equal(restarted.resources().length, 0)
  const replacement = restarted.claim({ ...BASE, instanceId: 'instance-2' }, 'dispatch:2')
  assert.equal(replacement.instanceId, 'instance-2')
  assert.equal(restarted.resources().length, 1)
  assert.equal((await restarted.reconcile(f.resource, KEY)).state, 'retired')
})

test('effect uncertainty never repeats, and path absence alone never reconciles it', async () => {
  const source = join(fixtureRoot, 'checkout-unknown')
  const retained = join(fixtureRoot, 'retained-unknown')
  writeFileSync(source, 'fixture')
  const f = setup({
    effect: () => {
      renameSync(source, retained)
      throw new Error('reply lost')
    }
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
  assert.equal(existsSync(source), false)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
  await assert.rejects(f.authority.retire(fence, 'different_key_0001'), /already_dispatched/)
  assert.equal((await f.authority.reconcile(f.resource, KEY)).state, 'unknown')
  assert.equal(f.effects(), 1)
  assert.throws(
    () => f.authority.claim({ ...BASE, instanceId: 'new' }, 'dispatch:2'),
    /custody_fenced/
  )
})

test('crash between effect completion and durable result cannot dispatch twice after restart', async () => {
  const f = setup({
    beforeWrite: (writes) => {
      if (writes >= 4) {
        throw new Error('disk failed')
      }
    }
  })
  const fence = await f.authority.capture(f.resource)
  const uncommitted = await f.authority.retire(fence, KEY)
  assert.equal(uncommitted.state, 'unknown')
  assert.equal(uncommitted.reason, 'native_outcome_commit_pending')
  assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
  assert.equal((await f.authority.reconcile(f.resource, KEY)).state, 'unknown')
  assert.equal(f.effects(), 1)
  assert.throws(() => f.authority.admit(BASE.worktreeId, BASE.path), /custody_fenced/)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'authority-2')
  restarted.installCoverage(BASE.owner, f.coverage)
  assert.equal((await restarted.retire(fence, KEY)).state, 'dispatched')
  assert.equal((await restarted.reconcile(f.resource, KEY)).state, 'unknown')
  assert.equal(f.effects(), 1)
})

test('native outcome reconciliation durably confirms same-key results and admits path reuse', async () => {
  const f = setup({
    effect: () => {
      throw new Error('lost reply')
    },
    reconcile: (outcome) => {
      assert.equal(outcome.key, KEY)
      assert.deepEqual(outcome.resource, f.resource)
      return {
        resource: outcome.resource,
        key: outcome.key,
        confirmed: true,
        proof: 'native-key-bound-outcome'
      }
    }
  })
  const fence = await f.authority.capture(f.resource)
  await f.authority.retire(fence, KEY)
  const writes = f.writes()
  assert.equal((await f.authority.reconcile(f.resource, KEY)).state, 'retired')
  assert.equal(f.writes(), writes + 1)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'reconciled-restart')
  assert.equal((await restarted.reconcile(f.resource, KEY)).state, 'retired')
  restarted.checkAdmission(BASE.worktreeId, BASE.path)
  f.authority.claim({ ...BASE, instanceId: 'instance-2' }, 'dispatch:2')
  assert.equal(f.authority.resources().length, 1)
})

test('wrong-resource, wrong-key and unavailable native outcome proofs remain unknown', async () => {
  for (const modify of [
    (outcome) => ({
      resource: { ...outcome.resource, instanceId: 'replacement' },
      key: outcome.key,
      confirmed: true,
      proof: 'other-instance'
    }),
    (outcome) => ({
      resource: outcome.resource,
      key: 'foreign_key_00001',
      confirmed: true,
      proof: 'other-key'
    }),
    () => {
      throw new Error('native authority unavailable')
    }
  ]) {
    const f = setup({
      effect: () => {
        throw new Error('lost reply')
      },
      reconcile: modify
    })
    const fence = await f.authority.capture(f.resource)
    await f.authority.retire(fence, KEY)
    const writes = f.writes()
    assert.equal((await f.authority.reconcile(f.resource, KEY)).state, 'unknown')
    assert.equal(f.writes(), writes)
    assert.equal(f.effects(), 1)
  }
})

test('a grant-release error cannot erase an already durable retired result', async () => {
  const f = setup({
    releaseGrant: () => {
      throw new Error('grant owner unavailable')
    }
  })
  const fence = await f.authority.capture(f.resource)
  const result = await f.authority.retire(fence, KEY)
  assert.equal(result.state, 'retired')
  assert.equal(result.reason, 'grant_release_pending')
  assert.equal((await f.authority.reconcile(f.resource, KEY)).state, 'retired')
  assert.equal(f.effects(), 1)
})

test('file journal persists exact bindings and refuses corruption, symlinks and competing writers', () => {
  const directory = join(fixtureRoot, 'journal')
  const first = new WorktreeCustodyFileJournal(directory)
  first.read()
  const record = {
    resource: { ...BASE, generation: 'disk-generation' },
    claim: 'disk-claim',
    releaseProof: null,
    revoked: false,
    fence: null,
    outcome: null
  }
  first.write({ records: [record], receipts: [] })
  const competing = new WorktreeCustodyFileJournal(directory)
  assert.deepEqual(competing.read().records, [record])
  first.write({ records: [{ ...record, releaseProof: 'native-release' }], receipts: [] })
  assert.throws(() => competing.write({ records: [], receipts: [] }), /writer_changed/)
  assert.equal(
    new WorktreeCustodyFileJournal(directory).read().records[0].releaseProof,
    'native-release'
  )
  writeFileSync(join(directory, 'custody.json'), '{broken')
  assert.throws(() => new WorktreeCustodyFileJournal(directory).read())
  const link = join(fixtureRoot, 'journal-link')
  symlinkSync(directory, link)
  assert.throws(() => new WorktreeCustodyFileJournal(link).read(), /symlink/)
})

test('claims churn is bounded separately from immutable retirement tombstones', async () => {
  const f = setup({ coverage: false })
  for (let i = 0; i < 2055; i++) {
    f.authority.claim({ ...BASE, worktreeId: `repo::/path-${i}`, path: `/path-${i}` }, `churn-${i}`)
    f.authority.release(`churn-${i}`, `release-${i}`)
  }
  assert.equal(f.authority.resources().length, 2048)
  assert.equal(f.writes(), 0)
  const retired = setup()
  const fence = await retired.authority.capture(retired.resource)
  await retired.authority.retire(fence, KEY)
  assert.equal(retired.journal.read().records.length, 0)
  assert.equal(retired.journal.read().receipts.length, 1)
  const restart = new WorktreeCustodyAuthority(retired.journal, 'tombstone-restart')
  assert.equal((await restart.retire(fence, KEY)).state, 'retired')
  await assert.rejects(restart.retire(fence, 'changed_key_00001'), /already_dispatched/)
  assert.throws(() => restart.claim(BASE, 'dispatch:1'), /claim_retired/)
  assert.equal(retired.effects(), 1)
})

test('journal capacity refuses before mutation and does not poison admission or old receipts', async () => {
  const f = setup({
    beforeWrite: (writes) => {
      if (writes === 2) {
        throw new Error('custody_journal_full')
      }
    }
  })
  await assert.rejects(f.authority.capture(f.resource), /journal_full/)
  assert.equal(f.authority.complete, true)
  f.authority.checkAdmission(BASE.worktreeId, BASE.path)
  assert.equal(f.effects(), 0)
  const journal = new WorktreeCustodyFileJournal(join(fixtureRoot, 'oversize-preflight'))
  assert.throws(
    () => journal.write({ records: [], receipts: [{ reason: 'x'.repeat(4 * 1024 * 1024) }] }),
    /journal_full/
  )
  assert.equal(existsSync(join(fixtureRoot, 'oversize-preflight')), false)
})

test('a sibling retired receipt cannot clear an independently pending effect', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  await f.authority.retire(fence, KEY)
  const state = f.journal.read()
  const pending = { ...f.resource, generation: 'independently-pending-generation' }
  state.records.push({
    resource: pending,
    claim: 'pending-other-claim',
    releaseProof: 'native-release',
    revoked: false,
    fence: { ...fence, resource: pending, token: 'other-token' },
    outcome: {
      resource: pending,
      key: 'pending_other_key_001',
      state: 'unknown',
      recordedAt: 100_000,
      reason: 'uncertain'
    }
  })
  const restarted = new WorktreeCustodyAuthority(
    { read: () => state, write: () => {} },
    'legacy-overlap-restart'
  )
  assert.throws(() => restarted.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  restarted.checkAdmission('unrelated', '/unrelated')
})

test('oversized reconciliation proof returns structured unknown without lifting durable pending protection', async () => {
  const f = setup({
    effect: () => {
      throw new Error('ambiguous')
    },
    reconcile: (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: true,
      proof: 'x'.repeat(4 * 1024 * 1024)
    })
  })
  const fence = await f.authority.capture(f.resource)
  await f.authority.retire(fence, KEY)
  const writes = f.writes()
  const outcome = await f.authority.reconcile(f.resource, KEY)
  assert.equal(outcome.state, 'unknown')
  assert.equal(outcome.reason, 'native_outcome_proof_oversized')
  assert.equal(f.writes(), writes)
  const restart = new WorktreeCustodyAuthority(f.journal, 'oversized-proof-restart')
  assert.throws(() => restart.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  assert.equal(f.effects(), 1)
})

test('refused replay preserves the canonical receipt and retries only its bound pending grant', async () => {
  let failRelease = true
  const f = nativeFixture(mkdtempSync(join(fixtureRoot, 'refused-release-')), false, {
    releaseGrant: () => {
      if (failRelease) {
        failRelease = false
        throw new Error('release acknowledgement unavailable')
      }
    }
  })
  let effects = 0
  nativePorts.setClean(() => {
    throw new Error('preflight')
  })
  nativePorts.setRemove(() => {
    effects++
  })
  const original = await f.authority.capture(f.resource)
  const refused = await f.authority.retire(original, KEY)
  assert.equal(refused.state, 'refused')
  assert.equal(refused.reason, 'custody_pre_effect_refused')
  assert.equal(f.grantReleased(), 1)
  const fresh = await f.authority.capture(f.resource)
  assert.deepEqual(await f.authority.reconcile(f.resource, KEY), refused)
  assert.equal(f.grantReleased(), 2)
  f.authority.check(fresh)
  assert.deepEqual(await f.authority.retire(original, KEY), refused)
  assert.equal(f.grantReleased(), 2)
  assert.equal(effects, 0)
  await f.authority.cancel(fresh)
  assert.equal(f.grantReleased(), 3)
  const restart = new WorktreeCustodyAuthority(f.journal, 'refused-grant-restart')
  assert.deepEqual(await restart.reconcile(f.resource, KEY), refused)
})

test('private journal forward compatibility preserves v2 retired receipts and rejects unknown future state', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  await f.authority.retire(fence, KEY)
  const directory = join(fixtureRoot, 'versioned-receipts')
  const writer = new WorktreeCustodyFileJournal(directory)
  writer.read()
  writer.write(f.journal.read())
  const path = join(directory, 'custody.json')
  const envelope = JSON.parse(readFileSync(path, 'utf8'))
  envelope.version = 2
  for (const receipt of envelope.receipts) {
    delete receipt.state
  }
  writeFileSync(path, JSON.stringify(envelope))
  const forward = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(directory),
    'forward-reader'
  )
  assert.equal((await forward.reconcile(f.resource, KEY)).state, 'retired')
  envelope.version = 4
  writeFileSync(path, JSON.stringify(envelope))
  const unsupported = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(directory),
    'unknown-reader'
  )
  assert.equal(unsupported.complete, false)
  assert.throws(() => unsupported.checkAdmission(BASE.worktreeId, BASE.path), /effects_unknown/)
  await assert.rejects(unsupported.reconcile(f.resource, KEY), /effects_unknown/)
})

test('inventory retries a refused terminal grant without Core replay or destructive resend', async () => {
  let fail = true
  const f = nativeFixture(mkdtempSync(join(fixtureRoot, 'inventory-release-')), false, {
    releaseGrant: () => {
      if (fail) {
        fail = false
        throw new Error('retry release')
      }
    }
  })
  let effects = 0
  nativePorts.setClean(() => {
    throw new Error('preflight')
  })
  nativePorts.setRemove(() => {
    effects++
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
  assert.equal(f.grantReleased(), 1)
  assert.equal(f.authority.resources().length, 1)
  assert.equal(f.grantReleased(), 2)
  f.authority.resources()
  assert.equal(f.grantReleased(), 2)
  assert.equal(effects, 0)
})
