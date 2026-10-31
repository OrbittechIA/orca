import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'vitest'
import { KEY, moduleFromSource, nativePorts } from './worktree-custody-fixture.mjs'
import { providerCheckout, providerFixture } from './worktree-custody-native-fixture.mjs'
import {
  runtimePorts,
  runtimeCustody,
  runtimeFixture,
  fixtureSelectionLocation,
  resolveCustodySelectionLocation,
  WORKTREE_SELECTION_REPORT_METHOD
} from './worktree-custody-runtime-fixture.mjs'

await moduleFromSource('selection-rounds.mjs', './worktree-custody-selection-rounds.ts', {
  '../../shared/worktree/custody': './custody.mjs'
})
const { WorktreeCustodySelections, nativeWorktreeCustodySelections } = await moduleFromSource(
  'selections.mjs',
  './worktree-custody-selections.ts',
  {
    './worktree-custody-runtime': './native-ports.mjs',
    '../../shared/app-environment': './runtime-ports.mjs',
    './worktree-custody-selection-rounds': './selection-rounds.mjs',
    '../../shared/cross-platform-path': './cross-platform-path.mjs'
  }
)

test('selection inventory survives runtime replacement and remains isolated by profile', () => {
  runtimePorts.setUserData('/fixture-profile-1')
  const firstRuntime = nativeWorktreeCustodySelections()
  const close = firstRuntime.open('connected-phone')
  assert.equal(nativeWorktreeCustodySelections(), firstRuntime)
  assert.equal(nativeWorktreeCustodySelections().selects('resource'), true)
  runtimePorts.setUserData('/fixture-profile-2')
  assert.notEqual(nativeWorktreeCustodySelections(), firstRuntime)
  assert.equal(nativeWorktreeCustodySelections().complete, true)
  runtimePorts.setUserData('/fixture-profile-1')
  close()
  assert.equal(nativeWorktreeCustodySelections().complete, true)
})

test('nonreporting connections hold every resource until reporting or disconnecting', () => {
  const admissions = []
  const selections = new WorktreeCustodySelections(
    (id) => {
      admissions.push(id)
      return () => {}
    },
    undefined,
    fixtureSelectionLocation
  )
  const close = selections.open('legacy-phone')
  assert.equal(selections.complete, false)
  assert.equal(selections.selects('unrelated-workspace'), true)
  selections.report('legacy-phone', ['selected'])
  assert.equal(selections.complete, false)
  selections.watch('legacy-phone', '11111111-1111-4111-8111-111111111111', () => {})
  assert.equal(selections.complete, true)
  assert.equal(selections.selects('selected'), true)
  assert.equal(selections.selects('unrelated-workspace'), false)
  assert.deepEqual(admissions, ['selected'])
  // Presence, focus and elapsed time are deliberately absent from the selection protocol.
  close()
  assert.equal(selections.selects('selected'), false)
  assert.throws(() => selections.report('legacy-phone', []), /connection_closed/)
})

test('disconnect between grant checks remains visible and an old close cannot retire a replacement', () => {
  const selections = new WorktreeCustodySelections(
    () => () => {},
    undefined,
    fixtureSelectionLocation
  )
  const generation = selections.generation
  const close = selections.open('one')
  close()
  assert.equal(selections.selects('resource'), false)
  assert.notEqual(selections.generation, generation)
  const closeReplacement = selections.open('one')
  close()
  assert.equal(selections.complete, false)
  selections.report('one', ['resource'])
  assert.equal(selections.selects('resource'), true)
  closeReplacement()
  assert.equal(selections.selects('resource'), false)
})

test('selection admission refusal preserves the prior selection and active reservations', () => {
  let reservations = 0
  const selections = new WorktreeCustodySelections(
    (id) => {
      if (id === 'retiring') {
        throw new Error('worktree_custody_fenced')
      }
      reservations++
      return () => reservations--
    },
    undefined,
    fixtureSelectionLocation
  )
  const close = selections.open('desktop')
  selections.watch('desktop', '11111111-1111-4111-8111-111111111111', () => {})
  selections.report('desktop', ['existing'])
  assert.throws(() => selections.report('desktop', ['new', 'retiring']), /fenced/)
  assert.equal(reservations, 0)
  assert.equal(selections.selects('existing'), true)
  assert.equal(selections.complete, false)
  assert.equal(selections.selects('new'), true)
  selections.report('desktop', ['existing'])
  assert.equal(selections.complete, true)
  assert.equal(selections.selects('new'), false)
  close()
})

test('the composed provider refuses a transient late client before the fixed Git effect', async () => {
  let authority
  const selections = new WorktreeCustodySelections(
    () => () => {},
    (fence) => authority?.clientFenceSettlement(fence) ?? null
  )
  const f = await providerFixture(providerCheckout('late-selection'), {
    pairedSelection: selections
  })
  authority = f.authority
  let effects = 0
  nativePorts.setRemove(async () => {
    effects++
  })
  await assert.rejects(f.authority.capture(f.resource), /producer_release_unproven/)
  f.authority.release(`dispatch:${f.resource.path}`, `native-worker-release:${f.resource.path}`)
  const fence = await f.authority.capture(f.resource)
  const close = selections.open('late-phone')
  close()
  await assert.rejects(f.authority.retire(fence, KEY), /custody_fence_invalid/)
  assert.equal(effects, 0)
  await f.authority.cancel(fence)
})

test('unrepresented direct callers hold cleanup without refusing their existing workflow', () => {
  const selections = new WorktreeCustodySelections(() => () => {})
  selections.holdUnrepresentedConnection()
  selections.holdUnrepresentedConnection()
  const close = selections.open('known-desktop')
  selections.report('known-desktop', [])
  close()
  assert.equal(selections.complete, false)
  assert.equal(selections.selects('resource'), true)
})

test('an unrepresented second view holds the physical connection until its actual disconnect', () => {
  const selections = new WorktreeCustodySelections(() => () => {})
  const close = selections.open('mobile-shell')
  const unwatch = selections.watch('mobile-shell', '11111111-1111-4111-8111-111111111111', () => {})
  selections.report('mobile-shell', [])
  assert.equal(selections.complete, true)
  assert.throws(
    () => selections.watch('mobile-shell', '22222222-2222-4222-8222-222222222222', () => {}),
    /connection_changed/
  )
  assert.equal(selections.complete, false)
  selections.report('mobile-shell', [])
  unwatch()
  selections.watch('mobile-shell', '33333333-3333-4333-8333-333333333333', () => {})
  assert.equal(selections.complete, false)
  assert.equal(selections.selects('any-workspace'), true)
  close()
  assert.equal(selections.complete, true)
})

function selectionReportFixture(repos = [], folders = []) {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'native-release:selection-fixture')
  let settlementAuthority = f.custody
  const admissions = []
  const selections = new WorktreeCustodySelections(
    (...args) => {
      admissions.push(args)
      return runtimeCustody.admitWorktreeCustody(...args)
    },
    (fence) => settlementAuthority.clientFenceSettlement(fence)
  )
  selections.open('reporting-view')
  selections.watch('reporting-view', '11111111-1111-4111-8111-111111111111', () => {})
  const store = {
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    getFolderWorkspaces: () => folders
  }
  const report = (workspaceIds) =>
    WORKTREE_SELECTION_REPORT_METHOD.handler(
      { workspaceIds, complete: true, kind: 'view' },
      {
        connectionId: 'reporting-view',
        runtime: { custodySelections: selections, requireStore: () => store }
      }
    )
  const claimsPath = join(
    runtimePorts.getAppEnvironment().getPath('userData'),
    'worktree-custody-v1',
    'custody.json'
  )
  return {
    ...f,
    selections,
    admissions,
    store,
    report,
    claimsPath,
    setSettlementAuthority: (authority) => {
      settlementAuthority = authority
    }
  }
}

test('native selection select/deselect holds without claims writes or revocation and capture stays eligible', async () => {
  const f = selectionReportFixture([{ id: 'repo', path: '/fixture', executionHostId: 'local' }])
  const before = readFileSync(f.claimsPath, 'utf8')
  assert.deepEqual(f.report([f.resource.worktreeId]), { reported: true })
  assert.equal(f.selections.complete, true)
  assert.equal(f.selections.selects(f.resource.worktreeId, f.resource.path, 'local'), true)
  assert.deepEqual(f.admissions, [[f.resource.worktreeId, f.resource.path, 'local', false]])
  f.report([])
  assert.equal(readFileSync(f.claimsPath, 'utf8'), before)
  assert.equal((await f.custody.observe(f.resource)).disposition, 'released')
  const fence = await f.custody.capture(f.resource)
  f.custody.check(fence)
  await f.custody.cancel(fence)
})

test('SSH and runtime/WSL selections overlapping a local fence never enter local custody admission', async () => {
  const f = selectionReportFixture([
    { id: 'remote', path: '/fixture', connectionId: 'ssh-fixture' },
    { id: 'wsl', path: '/fixture', executionHostId: 'runtime:wsl-fixture' }
  ])
  const fence = await f.custody.capture(f.resource)
  const before = readFileSync(f.claimsPath, 'utf8')
  f.report([`remote::${f.resource.path}`, `wsl::${f.resource.path}`])
  assert.equal(f.selections.complete, true)
  assert.equal(f.selections.selects(f.resource.worktreeId, f.resource.path, 'local'), false)
  assert.equal(
    f.selections.selects(f.resource.worktreeId, f.resource.path, 'ssh:ssh-fixture'),
    true
  )
  assert.equal(f.admissions.length, 0)
  assert.equal(readFileSync(f.claimsPath, 'utf8'), before)
  assert.throws(() => runtimeCustody.admitWorktreeCustody(f.resource.worktreeId), /fenced/)
  f.custody.check(fence)
  await f.custody.cancel(fence)
  assert.equal((await f.custody.observe(f.resource)).disposition, 'released')
})

test('missing, ambiguous, invalid and WSL UNC owners hold selection inventory without inferring local admission', () => {
  const f = selectionReportFixture([
    { id: 'twins', path: '/fixture', executionHostId: 'local' },
    { id: 'twins', path: '/fixture', connectionId: 'remote' },
    { id: 'bad', path: '/fixture', executionHostId: 'invalid-owner' },
    { id: 'contradiction', path: '/fixture', executionHostId: 'local', connectionId: 'remote' },
    { id: 'unc', path: '//wsl.localhost/Ubuntu' }
  ])
  const before = readFileSync(f.claimsPath, 'utf8')
  for (const id of [
    'missing::/fixture',
    'twins::/fixture',
    'bad::/fixture',
    'contradiction::/fixture',
    'unc:://wsl.localhost/Ubuntu/fixture'
  ]) {
    assert.equal(resolveCustodySelectionLocation(f.store, id), null)
    assert.deepEqual(f.report([id]), { reported: true })
    assert.equal(f.selections.complete, false)
    assert.equal(f.selections.selects(f.resource.worktreeId, f.resource.path, 'local'), true)
  }
  f.store.getRepos = () => {
    throw new Error('catalog read failed')
  }
  f.report(['twins::/fixture'])
  assert.equal(f.selections.complete, false)
  assert.equal(f.admissions.length, 0)
  assert.equal(readFileSync(f.claimsPath, 'utf8'), before)
  f.report([])
  assert.equal(f.selections.complete, true)
})

test('selected ancestor folders and folder instances hold overlapping resources only on their proven host', async () => {
  const checkout = providerCheckout('selected-ancestor')
  const parent = dirname(checkout)
  const f = selectionReportFixture(
    [{ id: 'folder-repo', kind: 'folder', path: parent, executionHostId: 'local' }],
    [{ id: 'ancestor', folderPath: parent, executionHostId: 'local' }]
  )
  for (const id of [
    'folder:ancestor',
    `folder-repo::${parent}::workspace:22222222-2222-4222-8222-222222222222`
  ]) {
    f.report([id])
    assert.equal(f.selections.complete, true)
    assert.equal(f.selections.selects('child', checkout, 'local'), true)
    assert.equal(f.selections.selects(id, checkout, 'ssh:another-host'), false)
    assert.equal(f.selections.selects('sibling', `${parent}-other/child`, 'local'), false)
  }
  const native = await providerFixture(checkout, { pairedSelection: f.selections })
  f.setSettlementAuthority(native.authority)
  native.authority.release(`dispatch:${checkout}`, `native-worker-release:${checkout}`)
  const observation = await native.provider.observe(native.resource)
  assert.equal(observation.domains.find((domain) => domain.domain === 'workspace')?.active, true)
  await assert.rejects(native.authority.capture(native.resource), /custody_selection_held/)
  f.report([])
  assert.equal(f.selections.selects('child', checkout, 'local'), false)
})
