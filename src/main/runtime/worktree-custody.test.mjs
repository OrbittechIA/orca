import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  symlinkSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { afterAll as after, test } from 'vitest'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-custody-fixture-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

function moduleFromSource(name, source, replacements = {}) {
  let javascript = stripTypeScriptTypes(readFileSync(new URL(source, import.meta.url), 'utf8'), {
    mode: 'transform'
  })
  for (const [original, replacement] of Object.entries(replacements)) {
    javascript = javascript
      .replaceAll(`'${original}'`, `'${replacement}'`)
      .replaceAll(`"${original}"`, `"${replacement}"`)
  }
  const path = join(fixtureRoot, name)
  writeFileSync(path, javascript)
  return import(pathToFileURL(path).href)
}

const contract = await moduleFromSource('custody.mjs', '../../shared/worktree/custody.ts')
const { WorktreeCustodyAuthority } = await moduleFromSource(
  'authority.mjs',
  './worktree-custody-authority.ts',
  {
    '../../shared/worktree/custody': './custody.mjs'
  }
)
const { WorktreeCustodyFileJournal } = await moduleFromSource(
  'journal.mjs',
  './worktree-custody-journal.ts',
  {
    '../../shared/worktree/custody': './custody.mjs'
  }
)
const BASE = {
  worktreeId: 'repo::/fixture/worktree',
  path: '/fixture/worktree',
  instanceId: 'instance-1',
  hostId: 'local',
  owner: 'orchestration',
  product: 'product-1',
  task: 'task-1'
}
const KEY = 'retirement_key_0001'

function setup(options = {}) {
  let durable = { records: [], receipts: [] }
  let now = 100_000
  let writes = 0
  let effects = 0
  let grantReleased = 0
  const journal = {
    read: () => structuredClone(durable),
    write: (records) => {
      writes++
      options.beforeWrite?.(writes, records)
      durable = structuredClone(records)
    }
  }
  let claims = { records: [], receipts: [] }
  const claimsJournal = {
    read: () => structuredClone(claims),
    write: (state) => {
      writes++
      options.beforeWrite?.(writes, state)
      claims = structuredClone(state)
    }
  }
  const authority = new WorktreeCustodyAuthority(journal, 'authority-1', () => now, claimsJournal)
  const resource = authority.claim(BASE, 'dispatch:1')
  const observation = () => ({
    resource,
    observedAt: now,
    disposition: 'released',
    releaseProof: 'producer-proof',
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: now,
      complete: true,
      active: false,
      held: false,
      proof: `native:${domain}`
    }))
  })
  const coverage = {
    observe: async () => (options.observe ? options.observe(observation()) : observation()),
    acquire: async () => {
      await options.acquire?.()
      return {
        check: () => (options.check ? options.check() : true),
        release: () => {
          grantReleased++
          options.releaseGrant?.()
        }
      }
    },
    retire: async (bound, check) => {
      check()
      effects++
      await options.effect?.(bound, check)
    },
    recoverFence: async (fence) =>
      options.recoverFence ? options.recoverFence(fence) : { fence, recovered: false, proof: null },
    reconcile: async (outcome) =>
      options.reconcile
        ? options.reconcile(outcome)
        : {
            resource: outcome.resource,
            key: outcome.key,
            confirmed: false,
            proof: null
          }
  }
  if (options.coverage !== false) authority.installCoverage('orchestration', coverage)
  if (options.release !== false) authority.release('dispatch:1', 'native-release:1')
  return {
    authority,
    resource,
    journal,
    claimsJournal,
    coverage,
    observation,
    advance: (ms) => {
      now += ms
    },
    effects: () => effects,
    writes: () => writes,
    grantReleased: () => grantReleased
  }
}

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
      if (writes >= 4) throw new Error('disk failed')
    }
  })
  const fence = await f.authority.capture(f.resource)
  await assert.rejects(f.authority.retire(fence, KEY), /disk failed/)
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

test('multiple producer claims expose only the latest generation without discarding history', () => {
  const f = setup()
  const newer = f.authority.claim({ ...BASE, task: 'task-2' }, 'dispatch:2')
  assert.deepEqual(f.authority.resources(), [newer])
  assert.equal(f.claimsJournal.read().records.length, 2)
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

writeFileSync(
  join(fixtureRoot, 'native-ports.mjs'),
  `
  let coverage;
  export function installNativeWorktreeCustodyCoverage(owner, installed) { coverage = installed; return () => {}; }
  export function installedCoverage() { return coverage; }
  export async function observeNativeWorktreeCustody(runtime, resource) { return runtime.observeNative(resource); }
  export function getStructuredAgentSessionHost() { return null; }
  export const pendingWorktreeRemovals = new Map();
  export const failedWorktreeRemovals = new Map();
  export function reconcileWorkerWorktreeCustodyRelease() {}
  let remove;
  export function setRemove(effect) { remove = effect; }
  export async function removeWorktree(...args) { return remove(...args); }
  export async function assertWorktreeCleanForRemoval() {}
`
)
const nativePorts = await import(pathToFileURL(join(fixtureRoot, 'native-ports.mjs')).href)
const { installNativeWorktreeCustodyRetirement } = await moduleFromSource(
  'retirement.mjs',
  './worktree-custody-retirement.ts',
  {
    '../../shared/worktree/custody': './custody.mjs',
    '../git/worktree': './native-ports.mjs',
    './worktree-custody-observation': './native-ports.mjs',
    './worktree-custody-runtime': './native-ports.mjs'
  }
)

function nativeFixture(path, nativeHold = false) {
  let durable = { records: [], receipts: [] }
  const authority = new WorktreeCustodyAuthority(
    {
      read: () => durable,
      write: (records) => {
        durable = structuredClone(records)
      }
    },
    'native-fixture-authority'
  )
  const resource = authority.claim(
    { ...BASE, path, worktreeId: `repo::${path}` },
    `dispatch:${path}`
  )
  const proof = (bound) => ({
    resource: bound,
    observedAt: Date.now(),
    disposition: 'unknown',
    releaseProof: null,
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: Date.now(),
      complete: true,
      active: domain === 'workspace' && nativeHold,
      held: false,
      proof: `native:${domain}`
    }))
  })
  const history = { chats: ['retained'], branches: ['retained'], session: ['retained'] }
  const runtime = {
    getRuntimeId: () => 'native-runtime-fixture',
    observeNative: proof,
    showManagedWorktree: async () => ({
      id: resource.worktreeId,
      path,
      instanceId: BASE.instanceId,
      hostId: 'local',
      projectId: BASE.product,
      isMainWorktree: false,
      isBare: false,
      childWorktreeIds: [],
      git: { path, head: 'preserved-head' }
    }),
    showRepo: async () => ({ kind: 'git', path: fixtureRoot }),
    stopPtys: () => {
      throw new Error('a no-stop operation cannot invoke teardown')
    },
    closeTerminal: () => {
      throw new Error('a no-stop operation cannot close sessions')
    },
    history
  }
  installNativeWorktreeCustodyRetirement(runtime, {
    owner: BASE.owner,
    observe: async (bound) => ({
      ...proof(bound),
      domains: proof(bound).domains.map((entry) => ({ ...entry, active: false }))
    }),
    acquire: async () => ({ check: () => true, release: () => {} }),
    recoverFence: async (fence) => ({ fence, recovered: false, proof: null }),
    reconcile: async (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: false,
      proof: null
    })
  })
  authority.installCoverage(BASE.owner, nativePorts.installedCoverage())
  authority.release(`dispatch:${path}`, `native-worker-release:${path}`)
  return { authority, resource, runtime }
}

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
    if (unsafe === 'symlink') symlinkSync(fixtureRoot, join(checkout, 'outside'))
    else {
      const children = join(checkout, 'files')
      mkdirSync(children)
      for (let i = 0; i < 2049; i++) writeFileSync(join(children, `file-${i}`), '')
    }
    const f = nativeFixture(checkout)
    nativePorts.setRemove(() => {
      assert.fail('unsafe native material must never reach Git')
    })
    const fence = await f.authority.capture(f.resource)
    assert.equal((await f.authority.retire(fence, KEY)).state, 'unknown')
    assert.equal(existsSync(checkout), true)
  }
})

const { observeNativeWorktreeCustody } = await moduleFromSource(
  'observation.mjs',
  './worktree-custody-observation.ts',
  {
    '../../shared/worktree/custody': './custody.mjs',
    '../native-chat/agent-session-wire/structured-agent-session-registry': './native-ports.mjs',
    '../worktree-removal-table': './native-ports.mjs',
    './worktree-custody-runtime': './native-ports.mjs'
  }
)

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
  for (let i = 0; i < 10; i++) f.authority.checkAdmission(BASE.worktreeId, BASE.path)
  assert.equal(f.writes(), before)
  assert.equal((await f.authority.observe(f.resource)).disposition, 'released')
  const fence = await f.authority.capture(f.resource)
  assert.throws(() => f.authority.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  await f.authority.cancel(fence)
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
      if (writes === 2) throw new Error('custody_journal_full')
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

writeFileSync(
  join(fixtureRoot, 'runtime-ports.mjs'),
  `
  let directory;
  export function setUserData(path) { directory = path; }
  export function hasAppEnvironment() { return true; }
  export function getAppEnvironment() { return { getPath: () => directory }; }
  export const WORKTREE_ID_SEPARATOR = '::';
  export function normalizeRuntimePathForComparison(value) { return value; }
  export function defineMethod(method) { return method; }
  export const WorktreeCustodyRequestSchema = {};
  export function observeNativeWorktreeCustody() { throw new Error('observation not reached by list'); }
`
)
const runtimePorts = await import(pathToFileURL(join(fixtureRoot, 'runtime-ports.mjs')).href)
await moduleFromSource('worktree-id.mjs', '../../shared/worktree/id.ts', {
  '../cross-platform-path': './runtime-ports.mjs',
  '../pty-session-id-format': './runtime-ports.mjs'
})
const { OrchestrationError } = await moduleFromSource(
  'orchestration-error.mjs',
  './orchestration/orchestration-error.ts'
)
const runtimeCustody = await moduleFromSource('runtime.mjs', './worktree-custody-runtime.ts', {
  '../../shared/app-environment': './runtime-ports.mjs',
  '../../shared/worktree/id': './worktree-id.mjs',
  '../../shared/worktree/custody': './custody.mjs',
  './worktree-custody-authority': './authority.mjs',
  './worktree-custody-journal': './journal.mjs',
  './orchestration/orchestration-error': './orchestration-error.mjs'
})
const { WORKTREE_CUSTODY_METHOD } = await moduleFromSource(
  'custody-rpc.mjs',
  './rpc/methods/worktree-custody.ts',
  {
    '../core': './runtime-ports.mjs',
    '../../worktree-custody-runtime': './runtime.mjs',
    '../../../../shared/worktree/custody-schema': './runtime-ports.mjs',
    '../../worktree-custody-observation': './runtime-ports.mjs'
  }
)

for (const fault of ['corrupt', 'unsafe-mode', 'readonly-mode', 'oversized', 'stale-lock']) {
  test(`default runtime Starts and worker enrollment survive optional claims ${fault}`, async () => {
    const profile = mkdtempSync(join(fixtureRoot, 'profile-'))
    const claims = join(profile, 'worktree-custody-v1')
    mkdirSync(claims, { mode: 0o700 })
    if (fault === 'unsafe-mode') chmodSync(claims, 0o755)
    else if (fault === 'stale-lock')
      writeFileSync(join(claims, 'writer.lock'), 'leftover', { mode: 0o600 })
    else if (fault === 'oversized')
      writeFileSync(join(claims, 'custody.json'), 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 })
    else if (fault === 'readonly-mode') chmodSync(claims, 0o500)
    else writeFileSync(join(claims, 'custody.json'), '{corrupt', { mode: 0o600 })
    runtimePorts.setUserData(profile)
    const custody = runtimeCustody.nativeWorktreeCustody('runtime-before')
    runtimeCustody.claimWorkerWorktreeCustody(
      {
        id: BASE.worktreeId,
        path: BASE.path,
        instanceId: BASE.instanceId,
        hostId: 'local',
        projectId: BASE.product,
        isMainWorktree: false
      },
      'default',
      BASE.task
    )
    custody.release('dispatch:default', 'native-default-release')
    runtimeCustody.admitWorktreeCustody(BASE.worktreeId)()
    runtimeCustody.assertWorktreeCustodyAdmission(BASE.worktreeId)
    assert.equal(runtimeCustody.nativeWorktreeCustody('runtime-after'), custody)
    assert.deepEqual(runtimeCustody.nativeWorktreeCustodyCapabilities('runtime-after'), [])
    assert.equal(existsSync(join(profile, 'worktree-custody-effects-v1')), false)
    const list = await WORKTREE_CUSTODY_METHOD.handler(
      { operation: 'list' },
      { runtime: { getRuntimeId: () => 'runtime-after' } }
    )
    assert.equal(list.supported, false)
    assert.equal(list.complete, fault === 'stale-lock' || fault === 'readonly-mode')
    chmodSync(claims, 0o700)
  })
}

function completeObservation(resource) {
  return {
    resource,
    observedAt: Date.now(),
    disposition: 'unknown',
    releaseProof: null,
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: Date.now(),
      complete: true,
      active: false,
      held: false,
      proof: `owning:${domain}`
    }))
  }
}

function runtimeFixture() {
  runtimePorts.setUserData(mkdtempSync(join(fixtureRoot, 'active-profile-')))
  const custody = runtimeCustody.nativeWorktreeCustody('runtime-1')
  const resource = custody.claim(BASE, 'dispatch:fixture')
  custody.installCoverage(BASE.owner, {
    observe: async (bound) => completeObservation(bound),
    acquire: async () => ({ check: () => true, release: () => {} }),
    retire: async () => {},
    reconcile: async (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: false,
      proof: null
    }),
    recoverFence: async (fence) => ({ fence, recovered: false, proof: null })
  })
  return { custody, resource }
}

test('runtime identity changes preserve live admissions, coverage and grants', async () => {
  const f = runtimeFixture()
  const release = runtimeCustody.admitWorktreeCustody(BASE.worktreeId)
  f.custody.release('dispatch:fixture', 'owning-release')
  assert.equal(runtimeCustody.nativeWorktreeCustody('runtime-2'), f.custody)
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  release()
  const fence = await f.custody.capture(f.resource)
  const same = runtimeCustody.nativeWorktreeCustody('runtime-3')
  same.check(fence)
  assert.throws(
    () => runtimeCustody.admitOrchestrationWorktreeCustody(BASE.worktreeId),
    (error) =>
      error instanceof OrchestrationError &&
      error.code === 'worktree_custody_refused' &&
      error.data.effectsApplied === false
  )
  await same.cancel(fence)
})

const { settleWorkerTerminalRelease } = await moduleFromSource(
  'worker-archive.mjs',
  './orchestration/db/worker-terminal/worker-terminal-archive.ts',
  {
    '../../../worktree-custody-runtime': './runtime.mjs',
    '../../orchestration-error': './orchestration-error.mjs'
  }
)

test('producer release waits for the last owned resource and actual commit, then retries durable rows', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(':memory:')
  try {
    sqlite.exec(`CREATE TABLE worker_dispatches (dispatch_id TEXT, state TEXT, worktree_id TEXT);
      CREATE TABLE worker_terminal_resources (id TEXT, owner_dispatch_id TEXT, origin_dispatch_id TEXT,
        prior_owner_dispatch_ids TEXT DEFAULT '[]', worktree_id TEXT, ownership_state TEXT, release_state TEXT,
        release_completed_at TEXT, release_error TEXT, updated_at TEXT);`)
    const f = runtimeFixture()
    sqlite
      .prepare('INSERT INTO worker_dispatches VALUES (?, ?, ?)')
      .run('fixture', 'completed', BASE.worktreeId)
    const insert = sqlite.prepare(`INSERT INTO worker_terminal_resources
      (id,owner_dispatch_id,origin_dispatch_id,worktree_id,ownership_state,release_state) VALUES (?, ?, ?, ?, 'owned', 'requested')`)
    for (const id of ['one', 'two']) insert.run(id, 'fixture', 'fixture', BASE.worktreeId)
    const database = {
      db: {
        prepare: (sql) => sqlite.prepare(sql),
        get isTransaction() {
          return sqlite.isTransaction
        }
      },
      getWorkerTerminalResource: (id) =>
        sqlite.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(id)
    }
    sqlite.exec('BEGIN')
    settleWorkerTerminalRelease.call(database, 'one')
    await Promise.resolve()
    assert.equal((await f.custody.observe(f.resource)).disposition, 'held')
    sqlite.exec('COMMIT')
    runtimeCustody.reconcileWorkerWorktreeCustodyRelease(database, f.resource)
    assert.equal((await f.custody.observe(f.resource)).disposition, 'held')
    sqlite.exec('BEGIN')
    settleWorkerTerminalRelease.call(database, 'two')
    sqlite.exec('ROLLBACK')
    await Promise.resolve()
    assert.equal((await f.custody.observe(f.resource)).disposition, 'held')
    sqlite.exec('BEGIN')
    settleWorkerTerminalRelease.call(database, 'two')
    await Promise.resolve()
    assert.equal((await f.custody.observe(f.resource)).disposition, 'held')
    sqlite.exec('COMMIT')
    runtimeCustody.reconcileWorkerWorktreeCustodyRelease(database, f.resource)
    assert.equal((await f.custody.observe(f.resource)).disposition, 'released')
    settleWorkerTerminalRelease.call(database, 'one')
    await Promise.resolve()
    assert.equal(
      (await f.custody.observe(f.resource)).releaseProof,
      'native-worker-release:fixture'
    )
  } finally {
    sqlite.close()
  }
})

writeFileSync(
  join(fixtureRoot, 'terminal-ports.mjs'),
  `
  export class OrcaRuntimeWithTerminalCreateDeduplication {}
  export function admitPairedCreateColors() {}
  export function resolveTerminalPresentation() { return 'background'; }
  function unused() { throw new Error('the fixture must stop at asynchronous launch preflight'); }
  export { unused as recordTerminalLaunchMetadata, unused as resolveTerminalLaunchResult,
    unused as terminalLaunchPublicFacts, unused as revealCreatedTerminal, unused as createDesktopTerminal,
    unused as terminalCreateTeamAllocation, unused as createIdempotentCallback, unused as recordPtySurface,
    unused as spawnSurfaceClaimSequence, unused as agentLaunchTokenFor, unused as withAgentLaunchToken,
    unused as seedPtyLaunchTitle, unused as migratedPaneRestoreHint, unused as paneSize,
    unused as resolvePtyFirstSize, unused as resolveLaunchCommandPaneAgent };
`
)
const terminalReplacements = Object.fromEntries(
  [
    './terminal-launch-result',
    './terminal-create-reveal',
    './terminal-create-deduplication',
    '../../orca-runtime-create-terminal-dependencies',
    '../../orca-runtime-create-terminal-desktop',
    './terminal-create-team-allocation',
    '../../orca-runtime-report-pty-spawn-commit',
    '../../pty-recorded-surface-topology',
    '../../../agent-launch/agent-launch-token',
    './pty-launch-title',
    '../../migrated-pane-restore-cwd',
    '../../../ipc/pty/pty-first-size',
    '../../runtime-agent-launch-resolution'
  ].map((path) => [path, './terminal-ports.mjs'])
)
const { OrcaRuntimeWithCreateTerminal } = await moduleFromSource(
  'terminal-create.mjs',
  './terminal/launch/terminal-create.ts',
  {
    ...terminalReplacements,
    '../../worktree-custody-runtime': './runtime.mjs'
  }
)

test('terminal create holds admission across async launch preflight and releases on rejection', async () => {
  const f = runtimeFixture()
  let fail
  let entered
  const preflight = new Promise((_, reject) => {
    fail = reject
  })
  const waiting = new Promise((resolve) => {
    entered = resolve
  })
  const runtime = new OrcaRuntimeWithCreateTerminal()
  runtime.ptyController = { spawn: () => assert.fail('preflight never spawned') }
  runtime.resolveTerminalCreateLaunchScope = async () => ({ id: BASE.worktreeId, path: BASE.path })
  runtime.resolveAgentTerminalCreateOptions = () => {
    entered()
    return preflight
  }
  const creating = runtime.createTerminal(`id:${BASE.worktreeId}`)
  await waiting
  f.custody.release('dispatch:fixture', 'owning-release')
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  fail(new Error('preflight refused'))
  await assert.rejects(creating, /preflight refused/)
  const fence = await f.custody.capture(f.resource)
  await f.custody.cancel(fence)
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

test('pending effects survive optional claims corruption and keep unrelated Starts available after restart', async () => {
  const f = setup()
  const fence = await f.authority.capture(f.resource)
  const pending = new WorktreeCustodyAuthority(f.journal, 'restart-with-bad-claims', Date.now, {
    read: () => {
      throw new Error('claims corrupt')
    },
    write: () => {
      throw new Error('EROFS')
    }
  })
  assert.equal(pending.complete, false)
  assert.throws(() => pending.checkAdmission(BASE.worktreeId, BASE.path), /custody_fenced/)
  pending.admit('repo::/unrelated', '/unrelated')()
  pending.installCoverage(BASE.owner, {
    ...f.coverage,
    recoverFence: async (held) => ({
      fence: held,
      recovered: true,
      proof: 'owning-recovery-with-independent-effect-state'
    })
  })
  await pending.cancel(fence)
  const again = new WorktreeCustodyAuthority(f.journal, 'after-independent-recovery')
  again.checkAdmission(BASE.worktreeId, BASE.path)
})

writeFileSync(
  join(fixtureRoot, 'refusal-detail-ports.mjs'),
  `
  function unused() { throw new Error('unrelated refusal classification not reached'); }
  export { unused as readAgentCliInstallationProblem, unused as readCodexInstallationProblem,
    unused as readAgentSessionArgumentProblem, unused as isAgentJournalResolution };
  export const AGENT_SESSION_REWIND_REASONS = [];
  export const TUI_AGENT_DISPLAY_NAMES = {};
`
)
await moduleFromSource(
  'refusal-details.mjs',
  '../../shared/agent-session-refusal-details.ts',
  Object.fromEntries(
    [
      './agent-cli-installation-problem',
      './codex-cli-installation',
      './agent-session-argument-problem',
      './agent-session-journal-schemas',
      './agent-session-rewind',
      './tui-agent-display-names'
    ].map((path) => [path, './refusal-detail-ports.mjs'])
  )
)
await moduleFromSource('refusals.mjs', '../../shared/agent-session-wire-refusals.ts', {
  './agent-session-refusal-details': './refusal-details.mjs'
})

async function boundaryModule(name, source, real) {
  const javascript = stripTypeScriptTypes(readFileSync(new URL(source, import.meta.url), 'utf8'), {
    mode: 'transform'
  })
  const exports = new Set()
  const replacements = { ...real }
  for (const match of javascript.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (real[match[2]]) continue
    replacements[match[2]] = `./${name}-ports.mjs`
    for (const field of match[1].split(',')) exports.add(field.trim().split(/\s+as\s+/)[0])
  }
  writeFileSync(
    join(fixtureRoot, `${name}-ports.mjs`),
    `function unreached() { throw new Error('session effect ran past custody refusal'); }\nexport { ${[...exports].map((key) => `unreached as ${key}`).join(', ')} };`
  )
  return moduleFromSource(`${name}.mjs`, source, replacements)
}
const sessionBoundaryImports = {
  '../../runtime/worktree-custody-runtime': './runtime.mjs',
  '../../../shared/agent-session-wire-refusals': './refusals.mjs'
}
const mutationBoundary = await boundaryModule(
  'mutation-boundary',
  '../native-chat/agent-session-wire/structured-agent-session-mutation-context.ts',
  sessionBoundaryImports
)
const attachBoundary = await boundaryModule(
  'attach-boundary',
  '../native-chat/agent-session-wire/structured-agent-session-attach-flow.ts',
  sessionBoundaryImports
)

test('fenced structured mutation and attach return typed refusals before store or provider effects', async () => {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'owning-release')
  const fence = await f.custody.capture(f.resource)
  const location = { workspaceId: BASE.worktreeId, executionHostId: 'local' }
  const mutation = await mutationBoundary.runStructuredAgentSessionMutation(
    {
      deps: { store: { getRecord: () => ({ location }) } }
    },
    {},
    { sessionId: 'fenced-session' },
    {}
  )
  assert.equal(mutation.ok, false)
  assert.equal(mutation.refusal.code, 'agent_session_ownership_unknown')
  const attached = await attachBoundary.performAttach({ params: { location } })
  assert.equal(attached.ok, false)
  assert.equal(attached.refusal.code, 'agent_session_ownership_unknown')
  assert.equal(attached.refusal.createAttemptRefusedBeforeCommit, true)
  await f.custody.cancel(fence)
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
