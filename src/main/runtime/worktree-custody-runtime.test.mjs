import {
  failureLeftByGit,
  interruptedRemovalPorts,
  interruptedLocalWorktreeRemovalJob
} from './worktree-custody-runtime-fixture.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { fixtureRoot, WorktreeCustodyAuthority, BASE, setup } from './worktree-custody-fixture.mjs'
import {
  runtimePorts,
  OrchestrationError,
  runtimeCustody,
  WORKTREE_CUSTODY_METHOD,
  runtimeFixture,
  settleWorkerTerminalRelease,
  OrcaRuntimeWithCreateTerminal,
  mutationBoundary,
  attachBoundary,
  placementPorts,
  placeWorkerAgent
} from './worktree-custody-runtime-fixture.mjs'

for (const fault of ['corrupt', 'unsafe-mode', 'readonly-mode', 'oversized', 'stale-lock']) {
  test(`default runtime Starts and worker enrollment survive optional claims ${fault}`, async () => {
    const profile = mkdtempSync(join(fixtureRoot, 'profile-'))
    const claims = join(profile, 'worktree-custody-v1')
    mkdirSync(claims, { mode: 0o700 })
    if (fault === 'unsafe-mode') {
      chmodSync(claims, 0o755)
    } else if (fault === 'stale-lock') {
      writeFileSync(join(claims, 'writer.lock'), 'leftover', { mode: 0o600 })
    } else if (fault === 'oversized') {
      writeFileSync(join(claims, 'custody.json'), 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 })
    } else if (fault === 'readonly-mode') {
      chmodSync(claims, 0o500)
    } else {
      writeFileSync(join(claims, 'custody.json'), '{corrupt', { mode: 0o600 })
    }
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
    for (const id of ['one', 'two']) {
      insert.run(id, 'fixture', 'fixture', BASE.worktreeId)
    }
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

test('worker placement reports typed custody refusal with truthful pre/post-creation effects', async () => {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'owning-release')
  const fence = await f.custody.capture(f.resource)
  const existing = {
    id: BASE.worktreeId,
    path: BASE.path,
    repoId: 'repo',
    hostId: 'local',
    projectId: BASE.product,
    instanceId: BASE.instanceId,
    isMainWorktree: false
  }
  const args = {
    runtime: {},
    db: {},
    dispatchId: 'new-worker',
    taskId: 'new-task',
    params: {},
    requestedWorktree: 'new-child',
    resolvedWorktree: existing,
    agent: 'codex',
    effects: [],
    onStage: () => {}
  }
  placementPorts.configure({
    ...existing,
    id: `${BASE.worktreeId}/child`,
    path: `${BASE.path}/child`,
    instanceId: 'created-child'
  })
  await assert.rejects(
    placeWorkerAgent(args),
    (error) => error instanceof OrchestrationError && error.data.effectsApplied === false
  )
  assert.equal(placementPorts.creates, 0)
  await assert.rejects(
    placeWorkerAgent({ ...args, creationTarget: {} }),
    (error) => error instanceof OrchestrationError && error.data.effectsApplied === true
  )
  assert.equal(placementPorts.creates, 1)
  f.custody.check(fence)
  await f.custody.cancel(fence)
})

test('startup interrupted removal refuses a captured resource before metadata or Git entry', async () => {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'owning-release')
  const fence = await f.custody.capture(f.resource)
  interruptedRemovalPorts.prepare()
  const job = interruptedLocalWorktreeRemovalJob(
    { worktreeId: BASE.worktreeId, worktreePath: BASE.path, repoId: 'repo' },
    {}
  )
  let refusal
  await assert.rejects(job.run(new AbortController().signal), (error) => {
    refusal = error
    return /custody_fenced/.test(error.message)
  })
  assert.deepEqual(interruptedRemovalPorts.counts, { metadata: 0, list: 0 })
  let remoteCleanup = 0
  const failure = await failureLeftByGit({}, refusal, async () => {
    remoteCleanup++
  })
  assert.equal(failure.message, refusal.message)
  assert.equal(remoteCleanup, 0)
  await f.custody.cancel(fence)
})

test('startup interrupted removal retains admission through async proof and releases on failure', async () => {
  const f = runtimeFixture()
  const entered = interruptedRemovalPorts.prepare()
  const settlement = Promise.withResolvers()
  interruptedRemovalPorts.setPending(settlement.promise)
  const job = interruptedLocalWorktreeRemovalJob(
    { worktreeId: BASE.worktreeId, worktreePath: BASE.path, repoId: 'repo' },
    { store: { getRepo: () => ({ path: '/fixture/repo' }) } }
  )
  const running = job.run(new AbortController().signal)
  await entered
  f.custody.release('dispatch:fixture', 'owning-release')
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  interruptedRemovalPorts.fail()
  await assert.rejects(running, /fixture list refusal/)
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  settlement.resolve({})
  await Promise.resolve()
  const fence = await f.custody.capture(f.resource)
  await f.custody.cancel(fence)
})
