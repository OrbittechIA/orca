import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  symlinkSync
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
    javascript = javascript.replaceAll(original, replacement)
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
  let durable = []
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
  const authority = new WorktreeCustodyAuthority(journal, 'authority-1', () => now)
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
  f.authority.cancel(fence)
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
  f.authority.cancel(fence)
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
  assert.throws(() => restarted.cancel(fence), /not_cancellable/)
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
      if (writes >= 5) throw new Error('disk failed')
    }
  })
  const fence = await f.authority.capture(f.resource)
  await assert.rejects(f.authority.retire(fence, KEY), /journal_unknown/)
  assert.equal(f.effects(), 1)
  assert.throws(() => f.authority.admit(BASE.worktreeId, BASE.path), /journal_unknown/)
  const restarted = new WorktreeCustodyAuthority(f.journal, 'authority-2')
  restarted.installCoverage(BASE.owner, f.coverage)
  assert.equal((await restarted.retire(fence, KEY)).state, 'dispatched')
  assert.equal((await restarted.reconcile(f.resource, KEY)).state, 'unknown')
  assert.equal(f.effects(), 1)
})

test('read-only native outcome reconciliation preserves the journal and admits confirmed path reuse', async () => {
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
  assert.equal(f.writes(), writes)
  f.authority.claim({ ...BASE, instanceId: 'instance-2' }, 'dispatch:2')
  assert.equal(f.authority.resources().length, 1)
})

test('multiple producer claims expose only the latest generation without discarding history', () => {
  const f = setup()
  const newer = f.authority.claim({ ...BASE, task: 'task-2' }, 'dispatch:2')
  assert.deepEqual(f.authority.resources(), [newer])
  assert.equal(f.journal.read().length, 2)
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

test('file journal persists exact bindings and refuses corruption, symlinks and competing writers', async () => {
  const directory = join(fixtureRoot, 'journal')
  const first = new WorktreeCustodyFileJournal(directory)
  const authority = new WorktreeCustodyAuthority(first, 'authority-a')
  const resource = authority.claim(BASE, 'dispatch:disk')
  const competing = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(directory),
    'authority-b'
  )
  authority.release('dispatch:disk', 'durable-native-release')
  assert.throws(() => competing.release('dispatch:disk', 'foreign-release'), /writer_changed/)
  const loaded = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(directory),
    'authority-c'
  )
  assert.deepEqual(loaded.resources(), [resource])
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
  let durable = []
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
    '../native-chat/agent-session-wire/structured-agent-session-registry': './native-ports.mjs'
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
