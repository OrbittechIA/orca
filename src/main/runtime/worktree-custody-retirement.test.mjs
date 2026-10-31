import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
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
  contract,
  WorktreeCustodyAuthority,
  CustodyPreEffectRefusal,
  BASE,
  KEY,
  setup
} from './worktree-custody-fixture.mjs'
import {
  nativePorts,
  nativeFixture,
  observeNativeWorktreeCustody
} from './worktree-custody-native-fixture.mjs'

test('fixed native retirement reaches only unforced branch-preserving Git effect and keeps history', async () => {
  const checkout = mkdtempSync(join(fixtureRoot, 'native-checkout-'))
  const retained = `${checkout}-preserved`
  writeFileSync(join(checkout, 'tracked-source'), 'fixture source')
  const f = nativeFixture(checkout)
  nativePorts.setRemove(async (repoPath, path, force, options) => {
    assert.equal(path, checkout)
    assert.equal(force, false)
    assert.equal(options.deleteBranch, false)
    assert.equal(options.knownRemovedWorktree.head, 'preserved-head')
    assert.equal(options.checkoutDeleteSignal.aborted, false)
    renameSync(path, retained)
    return {}
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'retired')
  assert.equal(readFileSync(join(retained, 'tracked-source'), 'utf8'), 'fixture source')
  assert.deepEqual(f.runtime.history, {
    chats: ['retained'],
    branches: ['retained'],
    session: ['retained']
  })
})

test('producer coverage cannot erase a positive native current-workspace hold', async () => {
  const checkout = mkdtempSync(join(fixtureRoot, 'native-held-'))
  const f = nativeFixture(checkout, true)
  nativePorts.setRemove(() => {
    assert.fail('active native workspace must never reach Git')
  })
  await assert.rejects(f.authority.capture(f.resource), /workspace_unproven_or_held/)
  assert.equal(existsSync(checkout), true)
})

test('native symlink and per-effect file budgets refuse before any Git operation', async () => {
  for (const unsafe of ['symlink', 'oversized']) {
    const checkout = mkdtempSync(join(fixtureRoot, `native-${unsafe}-`))
    if (unsafe === 'symlink') {
      symlinkSync(fixtureRoot, join(checkout, 'outside'))
    } else {
      const children = join(checkout, 'files')
      mkdirSync(children)
      for (let i = 0; i < 2049; i++) {
        writeFileSync(join(children, `file-${i}`), '')
      }
    }
    const f = nativeFixture(checkout)
    nativePorts.setRemove(() => {
      assert.fail('unsafe native material must never reach Git')
    })
    const fence = await f.authority.capture(f.resource)
    assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
    assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
    assert.equal(f.grantReleased(), 1)
    f.authority.checkAdmission(f.resource.worktreeId, f.resource.path)
    const restarted = new WorktreeCustodyAuthority(f.journal, 'preflight-refusal-restart')
    restarted.admit(f.resource.worktreeId, f.resource.path)()
    assert.equal((await restarted.retire(fence, KEY)).state, 'refused')
    assert.equal(existsSync(checkout), true)
  }
})

test('empty native terminals do not prove release, external idleness, recovery or preservation', async () => {
  const resource = { ...BASE, generation: 'native-generation' }
  const runtime = {
    showManagedWorktree: async () => ({
      id: BASE.worktreeId,
      path: BASE.path,
      instanceId: BASE.instanceId,
      hostId: 'local',
      projectId: BASE.product,
      isMainWorktree: false,
      isBare: false,
      workspaceStatus: 'completed',
      isPinned: false,
      childWorktreeIds: []
    }),
    getWorkspaceSessionForWorktree: () => ({ activeWorktreeId: BASE.worktreeId }),
    requireStore: () => ({ getWorkspaceSession: () => ({ activeWorktreeId: 'other-worktree' }) }),
    listTerminals: async () => ({
      terminals: [],
      totalCount: 0,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }),
    openedAgentSessionRecordStore: () => null,
    getOrchestrationDb: () => ({ listWorkerTerminalResources: () => [] })
  }
  const observed = await observeNativeWorktreeCustody(runtime, resource)
  assert.equal(observed.disposition, 'unknown')
  assert.equal(observed.releaseProof, null)
  assert.equal(observed.domains.find((entry) => entry.domain === 'terminal').active, false)
  assert.equal(observed.domains.find((entry) => entry.domain === 'workspace').active, false)
  for (const domain of [
    'recovery',
    'structured-session',
    'external-consumer',
    'registered-consumer',
    'preservation'
  ]) {
    assert.equal(observed.domains.find((entry) => entry.domain === domain).complete, false)
  }
  const reasons = contract.custodyObservationRefusals(resource, observed, Date.now())
  assert.ok(reasons.includes('producer_release_unproven'))
  assert.ok(reasons.includes('external-consumer_unproven_or_held'))
})

test('native released-session leases still refuse reserved or unreconciled recovery state', async () => {
  const resource = { ...BASE, generation: 'native-generation' }
  const runtime = {
    showManagedWorktree: async () => ({
      ...BASE,
      id: BASE.worktreeId,
      projectId: BASE.product,
      isMainWorktree: false,
      isBare: false,
      workspaceStatus: 'completed',
      isPinned: false,
      childWorktreeIds: []
    }),
    getWorkspaceSessionForWorktree: () => ({
      sleepingAgentSessionsByPaneKey: { pane: { worktreeId: BASE.worktreeId } }
    }),
    requireStore: () => ({ getWorkspaceSession: () => ({ activeWorktreeId: null }) }),
    listTerminals: async () => {
      throw new Error('inventory unavailable')
    },
    openedAgentSessionRecordStore: () => ({
      listRecords: () => [
        {
          location: { workspaceId: BASE.worktreeId },
          lease: {
            claimStatus: 'released',
            unreconciled: true,
            handoffStage: null,
            reservedSpawnToken: 'held'
          }
        }
      ]
    }),
    getOrchestrationDb: () => ({
      listWorkerTerminalResources: () => [
        {
          worktreeId: BASE.worktreeId,
          dispatchStatus: 'completed',
          pendingInput: false,
          pendingApproval: true,
          terminalState: 'released'
        }
      ]
    })
  }
  const observed = await observeNativeWorktreeCustody(runtime, resource)
  for (const domain of ['structured-session', 'recovery', 'dispatch']) {
    assert.equal(observed.domains.find((entry) => entry.domain === domain).held, true)
  }
  assert.equal(observed.domains.find((entry) => entry.domain === 'terminal').complete, false)
})

for (const refusal of ['dirty', 'expiry', 'identity']) {
  test(`fixed native ${refusal} refusal is durable before removal entry and releases the grant`, async () => {
    const checkout = mkdtempSync(join(fixtureRoot, `preflight-${refusal}-`))
    let now = Date.now() + 1000
    const f = nativeFixture(checkout, false, { now: () => now })
    let effects = 0
    nativePorts.setRemove(() => {
      effects++
      assert.fail('refused preflight reached removal')
    })
    if (refusal === 'dirty') {
      nativePorts.setClean(() => {
        throw new Error('dirty worktree')
      })
    } else {
      const show = f.runtime.showManagedWorktree
      f.runtime.showManagedWorktree = async (...args) => {
        const worktree = await show(...args)
        if (refusal === 'expiry') {
          now += 30_001
        }
        return refusal === 'identity' ? { ...worktree, instanceId: 'replacement' } : worktree
      }
    }
    const fence = await f.authority.capture(f.resource)
    assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
    assert.equal(f.grantReleased(), 1)
    assert.equal(effects, 0)
    f.authority.checkAdmission(f.resource.worktreeId, f.resource.path)
    const restart = new WorktreeCustodyAuthority(f.journal, `restart-${refusal}`)
    restart.admit(f.resource.worktreeId, f.resource.path)()
    assert.equal((await restart.retire(fence, KEY)).state, 'refused')
  })
}

test('a typed no-effect refusal spends its key but needs a fresh fence for another attempt', async () => {
  let refuse = true
  const f = setup({
    effect: (resource) => {
      if (refuse) {
        throw new CustodyPreEffectRefusal(resource, new Error('owning preflight'))
      }
    }
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
  await assert.rejects(f.authority.retire(fence, 'new_attempt_key_0001'), /fence_invalid/)
  refuse = false
  const fresh = await f.authority.capture(f.resource)
  assert.notEqual(fresh.token, fence.token)
  assert.equal((await f.authority.retire(fresh, 'new_attempt_key_0001')).state, 'retired')
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
})

test('an untyped budget-looking exception is unknown and cannot authorize admission', async () => {
  const f = setup({
    effect: () => {
      throw new Error('custody_effect_budget')
    }
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
  assert.equal(f.grantReleased(), 0)
  assert.throws(() => f.authority.admit(BASE.worktreeId, BASE.path), /custody_fenced/)
})

test('any exception after fixed removal entry stays unknown, including a typed-looking refusal', async () => {
  const checkout = mkdtempSync(join(fixtureRoot, 'entered-effect-'))
  const f = nativeFixture(checkout)
  let entered = 0
  nativePorts.setRemove(() => {
    entered++
    throw new CustodyPreEffectRefusal(f.resource, new Error('late exception'))
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
  assert.equal(entered, 1)
  assert.equal(f.grantReleased(), 0)
  assert.throws(
    () => f.authority.checkAdmission(f.resource.worktreeId, f.resource.path),
    /custody_fenced/
  )
  const restart = new WorktreeCustodyAuthority(f.journal, 'entered-effect-restart')
  assert.throws(
    () => restart.checkAdmission(f.resource.worktreeId, f.resource.path),
    /custody_fenced/
  )
})
