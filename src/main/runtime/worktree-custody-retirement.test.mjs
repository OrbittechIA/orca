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
  BASE,
  KEY,
  setup
} from './worktree-custody-fixture.mjs'
import {
  nativePorts,
  nativeFixture,
  observeNativeWorktreeCustody,
  providerPorts,
  gate,
  provider,
  proveWorktreePreservation,
  cleanGit
} from './worktree-custody-native-fixture.mjs'
import { createCoreTablesSql } from './worktree-custody-runtime-fixture.mjs'
import { installNativeWorktreeCustodyRetirement } from './worktree-custody-fixture.mjs'

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

test('a fixed no-effect refusal spends its key but needs a fresh fence for another attempt', async () => {
  const checkout = mkdtempSync(join(fixtureRoot, 'fresh-after-refusal-'))
  const f = nativeFixture(checkout)
  nativePorts.setClean(() => {
    throw new Error('dirty checkout')
  })
  nativePorts.setRemove(() => {})
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
  assert.equal((await f.authority.retire(fence, KEY)).state, 'refused')
  await assert.rejects(f.authority.retire(fence, 'new_attempt_key_0001'), /fence_invalid/)
  nativePorts.setClean(() => {})
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
    throw Object.assign(new Error('custody_pre_effect_refused'), {
      resource: f.resource,
      proof: 'native-preflight:forged',
      name: 'CustodyPreEffectRefusal'
    })
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

test('generic coverage cannot reuse a real fixed-port refusal by replacing its callback after an effect', async () => {
  const checkout = mkdtempSync(join(fixtureRoot, 'foreign-proof-'))
  let fixed, captured
  let effects = 0
  const f = nativeFixture(checkout, false, {
    coverage: (coverage) => {
      fixed = coverage
      const wrapped = {
        ...coverage,
        retire: async () => {
          effects++
          wrapped.retire = coverage.retire
          throw captured
        }
      }
      return wrapped
    }
  })
  nativePorts.setClean(() => {
    throw new Error('preflight')
  })
  try {
    await fixed.retire(f.resource, () => {})
  } catch (error) {
    captured = error
  }
  assert.ok(captured instanceof Error)
  const authority = f.authority
  const fence = await authority.capture(f.resource)
  const outcome = await authority.retire(fence, KEY)
  assert.equal(outcome.state, 'unknown')
  assert.equal(effects, 1)
  assert.equal(f.grantReleased(), 0)
  assert.throws(() => authority.admit(f.resource.worktreeId, f.resource.path), /custody_fenced/)
  const restart = new WorktreeCustodyAuthority(f.journal, 'foreign-proof-restart')
  assert.throws(
    () => restart.checkAdmission(f.resource.worktreeId, f.resource.path),
    /custody_fenced/
  )
  assert.equal((await restart.retire(fence, KEY)).state, 'unknown')
  assert.equal(effects, 1)
})

const RELEASED_LEASE = {
  claimStatus: 'released',
  unreconciled: false,
  handoffStage: null,
  reservedSpawnToken: null
}

/** Real authority, native observation, watcher gate and provider; only host stores are in memory. */
async function providerFixture(checkout, options = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(createCoreTablesSql())
  for (const state of options.workers ?? ['succeeded']) {
    sqlite
      .prepare('INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES (?, ?, ?)')
      .run(`dispatch-${state}`, state, `repo::${checkout}`)
  }
  nativePorts.setClean(() => {})
  let durable = { records: [], receipts: [] }
  const authority = new WorktreeCustodyAuthority(
    { read: () => durable, write: (state) => (durable = structuredClone(state)) },
    options.authorityId ?? 'provider-fixture-authority',
    Date.now,
    options.claims
  )
  const worktreeId = `repo::${checkout}`
  const resource = authority.claim(
    { ...BASE, path: checkout, worktreeId, ...options.claim },
    `dispatch:${checkout}`
  )
  const session = {
    activeWorktreeId: null,
    sleepingAgentSessionsByPaneKey: {},
    openFilesByWorktree: {},
    ...options.session
  }
  const records = options.records ?? [
    { sessionId: 'finished-session', location: { workspaceId: worktreeId }, lease: RELEASED_LEASE }
  ]
  const runtime = {
    getRuntimeId: () => 'provider-fixture-runtime',
    showManagedWorktree: async () => ({
      id: worktreeId,
      repoId: 'repo',
      path: checkout,
      instanceId: BASE.instanceId,
      hostId: 'local',
      projectId: options.physicalProject ?? BASE.product,
      isMainWorktree: false,
      isBare: false,
      workspaceStatus: 'completed',
      isPinned: false,
      childWorktreeIds: [],
      git: { path: checkout, head: 'preserved-head' }
    }),
    showRepo: async () => ({ kind: 'git', path: fixtureRoot }),
    getWorkspaceSessionForWorktree: () => session,
    requireStore: () => ({ getWorkspaceSession: () => ({ activeWorktreeId: null }) }),
    listTerminals: async () => ({
      terminals: [],
      totalCount: 0,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }),
    openedAgentSessionRecordStore: () => ({ listRecords: () => records }),
    getOrchestrationDb: () => ({
      db: { prepare: (sql) => sqlite.prepare(sql) },
      listWorkerTerminalResources: () => [
        {
          worktreeId,
          dispatchStatus: 'completed',
          terminalState: 'released',
          pendingInput: false,
          pendingApproval: false
        }
      ]
    })
  }
  runtime.observeNative = (bound) => observeNativeWorktreeCustody(runtime, bound)
  let externalReleases = 0
  const ports = {
    runtime,
    structuredWork: () => undefined,
    removals: () => [...providerPorts.pendingWorktreeRemovals.values()],
    desktopWatchRoots: () =>
      [...providerPorts.watcherLifecycleState.watchedRoots.values()].map((root) => root.rootPath),
    runtimeWatchLeases: (path) => providerPorts.runtimeLeases.get(path)?.size ?? 0,
    fenceInstalls: (path) => gate.acquireWatcherRemovalGate(path),
    preservation: (path) => proveWorktreePreservation(path, cleanGit(path, options.git)),
    // Stands in for the external-consumer authority this host does not have.
    external:
      options.external === null
        ? null
        : {
            observe: async () => ({
              observedAt: Date.now(),
              complete: true,
              active: false,
              held: false,
              proof: 'qualified-external-authority'
            }),
            acquire: async () => ({ check: () => true, release: () => externalReleases++ })
          }
  }
  const created = provider.createNativeWorktreeCustodyProvider(ports)
  if (created.ready) {
    installNativeWorktreeCustodyRetirement(runtime, created)
    authority.installCoverage(created.owner, nativePorts.installedCoverage())
  }
  return {
    authority,
    resource,
    provider: created,
    runtime,
    sqlite,
    externalReleases: () => externalReleases
  }
}

function providerCheckout(name) {
  const checkout = mkdtempSync(join(fixtureRoot, `provider-${name}-`))
  writeFileSync(join(checkout, 'tracked-source'), 'fixture source')
  return checkout
}

test('owned completed resource retires through the real provider, gate and fixed effect', async () => {
  const checkout = providerCheckout('positive')
  const retained = `${checkout}-preserved`
  const f = await providerFixture(checkout)
  f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const observed = await f.authority.observe(f.resource)
  assert.deepEqual(contract.custodyObservationRefusals(f.resource, observed, Date.now()), [])
  assert.match(
    observed.domains.find((entry) => entry.domain === 'preservation').proof,
    /^git-preservation:refs\/heads\/feature@a{40}$/
  )
  const fence = await f.authority.capture(f.resource)
  // The grant positively fences fresh PTY and watcher installs, beyond custody admission.
  assert.throws(() => gate.beginTerminalInstall(join(checkout, 'src')), /terminal removal/)
  assert.throws(() => gate.beginWatcherInstall(checkout), /watcher removal/)
  assert.throws(() => f.authority.checkAdmission(f.resource.worktreeId, checkout), /fenced/)
  f.authority.check(fence)
  nativePorts.setRemove(async (_repo, path, force, options) => {
    assert.equal(force, false)
    assert.equal(options.deleteBranch, false)
    renameSync(path, retained)
    return {}
  })
  assert.equal((await f.authority.retire(fence, KEY)).state, 'retired')
  assert.equal(readFileSync(join(retained, 'tracked-source'), 'utf8'), 'fixture source')
  assert.equal(f.externalReleases(), 1)
  gate.beginTerminalInstall(checkout)()
  f.sqlite.close()
})

test('a consumer appearing under the grant invalidates the fence before any effect', async () => {
  const checkout = providerCheckout('late-consumer')
  const f = await providerFixture(checkout)
  f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const fence = await f.authority.capture(f.resource)
  providerPorts.watcherLifecycleState.watchedRoots.set('late', { rootPath: join(checkout, 'src') })
  try {
    nativePorts.setRemove(() => assert.fail('a live watcher must never reach Git'))
    assert.throws(() => f.authority.check(fence), /custody_fence_invalid/)
    await assert.rejects(f.authority.retire(fence, KEY), /custody_fence_invalid/)
  } finally {
    providerPorts.watcherLifecycleState.watchedRoots.delete('late')
  }
  await f.authority.cancel(fence)
  gate.beginWatcherInstall(checkout)()
  assert.equal(existsSync(checkout), true)
  f.sqlite.close()
})

test('missing, active, held, reopened, foreign and legacy resources stay protected', async () => {
  const refusals = async (f) =>
    contract.custodyObservationRefusals(
      f.resource,
      await f.authority.observe(f.resource),
      Date.now()
    )
  const release = (f, checkout) =>
    f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const cases = {
    'missing external authority': [{ external: null }, 'external-consumer_unproven_or_held'],
    'live structured session': [
      {
        records: [
          {
            sessionId: 'live',
            location: { workspaceId: null },
            lease: { ...RELEASED_LEASE, claimStatus: 'live' }
          }
        ]
      },
      'structured-session_unproven_or_held'
    ],
    'recoverable worker': [{ workers: ['succeeded', 'stop_unknown'] }, 'recovery_unproven_or_held'],
    'open editor tab': [{ session: { openFilesByWorktree: null } }, 'workspace_unproven_or_held'],
    'ignored unique material': [
      { git: { status: '!! .env.local\0' } },
      'preservation_unproven_or_held'
    ],
    'skip-worktree edit': [
      { git: { 'ls-files -v': 'S tracked-source\0' } },
      'preservation_unproven_or_held'
    ],
    'foreign physical project': [{ physicalProject: 'other-project' }, 'terminal_unproven_or_held']
  }
  for (const [name, [options, reason]] of Object.entries(cases)) {
    const checkout = providerCheckout(name.replaceAll(' ', '-'))
    const worktreeId = `repo::${checkout}`
    if (name === 'live structured session') {
      options.records[0].location.workspaceId = worktreeId
    }
    if (name === 'open editor tab') {
      options.session.openFilesByWorktree = { [worktreeId]: [{ filePath: 'notes.md' }] }
    }
    const f = await providerFixture(checkout, options)
    release(f, checkout)
    assert.ok((await refusals(f)).includes(reason), name)
    await assert.rejects(f.authority.capture(f.resource), /custody_/, name)
    assert.equal(existsSync(checkout), true, name)
    f.sqlite.close()
  }

  const watched = providerCheckout('watched')
  providerPorts.runtimeLeases.set(watched, new Set(['mobile-explorer']))
  try {
    const f = await providerFixture(watched)
    release(f, watched)
    assert.ok((await refusals(f)).includes('registered-consumer_unproven_or_held'))
    await assert.rejects(f.provider.acquire(f.resource), /registered_consumer_held/)
    gate.beginWatcherInstall(watched)()
    f.sqlite.close()
  } finally {
    providerPorts.runtimeLeases.delete(watched)
  }

  const reopened = providerCheckout('reopened')
  const f = await providerFixture(reopened)
  release(f, reopened)
  f.authority.admit(f.resource.worktreeId, reopened)()
  assert.ok((await refusals(f)).includes('producer_release_unproven'))
  f.sqlite.close()

  // A prior incarnation's release has no consumer history across the gap; recovery refuses it.
  const legacy = providerCheckout('legacy')
  let stored = { records: [], receipts: [] }
  const claims = {
    read: () => structuredClone(stored),
    write: (state) => (stored = structuredClone(state))
  }
  const prior = await providerFixture(legacy, { authorityId: 'prior-incarnation', claims })
  release(prior, legacy)
  assert.equal(stored.records[0].releaseEpoch, 'prior-incarnation')
  const current = await providerFixture(legacy, { authorityId: 'current-incarnation', claims })
  assert.equal(current.resource.generation, prior.resource.generation)
  assert.ok((await refusals(current)).includes('producer_release_unproven'))
  await assert.rejects(current.authority.capture(current.resource), /producer_release_unproven/)
  prior.sqlite.close()
  current.sqlite.close()
})

test('host composition installs observation only while no external authority exists', async () => {
  const checkout = providerCheckout('composition')
  const f = await providerFixture(checkout, { external: null })
  assert.equal(f.provider.ready, false)
  providerPorts.setAuthority(f.authority)
  try {
    provider.installNativeWorktreeCustodyProvider(f.runtime)
    provider.installNativeWorktreeCustodyProvider(f.runtime)
    assert.equal(f.authority.supported, false)
    f.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
    const observed = await f.authority.observe(f.resource)
    assert.equal(observed.disposition, 'released')
    assert.equal(
      observed.domains.find((entry) => entry.domain === 'external-consumer').complete,
      false
    )
    await assert.rejects(f.authority.capture(f.resource), /custody_coverage_unsupported/)
    const ports = provider.nativeCustodyProviderPorts(f.runtime)
    assert.equal(ports.external, null)
    await assert.rejects(
      provider.createNativeWorktreeCustodyProvider(ports).acquire(f.resource),
      /external_consumer_unproven/
    )
    // Prior-incarnation fence, release and unknown outcome recovery all stay unconfirmed.
    const created = provider.createNativeWorktreeCustodyProvider(ports)
    assert.equal((await created.recoverFence({ resource: f.resource })).recovered, false)
    assert.equal((await created.recoverRelease({ resource: f.resource })).confirmed, false)
    assert.equal((await created.reconcile({ resource: f.resource, key: KEY })).confirmed, false)
  } finally {
    providerPorts.setAuthority(null)
    f.sqlite.close()
  }
})
