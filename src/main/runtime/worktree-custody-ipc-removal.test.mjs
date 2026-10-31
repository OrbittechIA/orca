import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'
import { fixtureRoot, moduleFromSource, BASE, KEY } from './worktree-custody-fixture.mjs'
import { runtimeCustody, runtimeFixture } from './worktree-custody-runtime-fixture.mjs'

writeFileSync(
  join(fixtureRoot, 'ipc-removal-ports.mjs'),
  `
  export const handlers = new Map();
  export const pending = new Map();
  export const counts = { lifecycle: 0, execute: 0, nested: 0 };
  let execute;
  export function configure(effect) { handlers.clear(); pending.clear(); execute = effect; counts.lifecycle = counts.execute = counts.nested = 0; }
  export const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
  export function getLocalWorktreeCatalogVersion() { return 7; }
  export function getRepoExecutionHostId(repo) { return repo.hostId; }
  export function withWorktreeSpan(_span, run) { return run(); }
  export function areWorktreePathsEqual(left, right) { return left === right; }
  export function parseWorktreeId(id) { const at = id.indexOf('::'); return { repoId: id.slice(0, at), worktreePath: id.slice(at + 2) }; }
  export function resolveRepoForExecutionHost(_store, id, hostId) { return { id, hostId: hostId ?? 'local', path: '/fixture/repo' }; }
  export function executeWorktreeRemoval(...args) { counts.execute++; return execute(...args); }
  export function previewNestedWorktreeRemoval() { throw new Error('preview not under test'); }
  export async function removeApprovedNestedWorktrees() { counts.nested++; return []; }
  export function getWorktreeRemovalInFlightKey(id, hostId) { return id + ':' + hostId; }
  export function getWorktreeRemovalOptionsKey(args) { return JSON.stringify([args.force, args.runHooks]); }
  export function waitForPendingWorktreeRemoval(id, hostId) { return hostId === 'local' ? pending.get(id) : undefined; }
  export async function finishAcceptedWorktreeRemoval(accepted, id, hostId) {
    const result = accepted.removing ? waitForPendingWorktreeRemoval(id, hostId) : undefined;
    return result ? await result : accepted;
  }
  export function runSerializedWorktreeRemovalAcceptance(_path, accept) { return accept(); }
  export function assertWslMoveRepoWritable() {}
  export function runWorkspaceLifecycleCommand(_queue, _key, command) { counts.lifecycle++; return command.run(); }
  export function workspaceLifecycleKey(hostId, id) { return hostId + ':' + id; }
  export function deleteLostContact() { return false; }
  export function observeTerminals() { return async () => {}; }
`
)
const ipcRemovalPorts = await import(pathToFileURL(join(fixtureRoot, 'ipc-removal-ports.mjs')).href)
const ipcRemovalImports = Object.fromEntries(
  [
    'electron',
    '../../../local-worktree-scan-generation',
    '../../../../shared/execution-host',
    '../../../observability/instrumentation',
    '../../../git/worktree-path-comparison',
    '../../worktree-logic',
    './execute-worktree-removal',
    './nested-worktree-removal',
    './worktree-removal-coordinator',
    '../repo-host-ownership',
    '../../../worktree-background-removal',
    '../../../worktree-removal-acceptance-queue',
    '../../../persistence/moving-wsl-projects/wsl-move-scope-guard',
    '../../../runtime/workspaces/workspace-lifecycle-commands'
  ].map((path) => [path, './ipc-removal-ports.mjs'])
)
const { registerWorktreeRemovalHandlers } = await moduleFromSource(
  'ipc-removal.mjs',
  '../ipc/worktrees/removal/register-worktree-removal-handlers.ts',
  {
    ...ipcRemovalImports,
    '../../../runtime/worktree-custody-runtime': './runtime.mjs'
  }
)
function removalHandler(effect) {
  ipcRemovalPorts.configure(effect)
  registerWorktreeRemovalHandlers({
    store: {},
    options: {},
    worktreeRemovalsInFlight: new Map(),
    runtime: { workspaceLifecycle: null }
  })
  return ipcRemovalPorts.handlers.get('worktrees:remove')
}

for (const pendingState of ['captured', 'unknown']) {
  test(`desktop IPC removal refuses ${pendingState} custody before lifecycle, nested or removal effects`, async () => {
    const f = runtimeFixture({
      retire: async () => {
        throw new Error('ambiguous effect')
      }
    })
    f.custody.release('dispatch:fixture', 'owning-release')
    const fence = await f.custody.capture(f.resource)
    if (pendingState === 'unknown') {
      assert.equal((await f.custody.retire(fence, KEY)).state, 'unknown')
    }
    const remove = removalHandler(() => assert.fail('IPC effect ran while fenced'))
    await assert.rejects(
      remove(null, { worktreeId: BASE.worktreeId, approvedNestedWorktrees: [{ path: BASE.path }] }),
      (error) => error instanceof runtimeCustody.WorktreeCustodyAdmissionError
    )
    assert.deepEqual(ipcRemovalPorts.counts, { lifecycle: 0, execute: 0, nested: 0 })
    if (pendingState === 'captured') {
      await f.custody.cancel(fence)
    }
  })
}

test('desktop IPC admission covers acceptance, coalescing and background settlement', async () => {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'owning-release')
  let entered
  let accept
  let settle
  const accepting = new Promise((resolve) => {
    entered = resolve
  })
  const acceptance = new Promise((resolve) => {
    accept = resolve
  })
  const background = new Promise((resolve) => {
    settle = resolve
  })
  const remove = removalHandler(async () => {
    entered()
    return acceptance
  })
  const one = remove(null, { worktreeId: BASE.worktreeId })
  await accepting
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  const two = remove(null, { worktreeId: BASE.worktreeId })
  assert.equal(ipcRemovalPorts.counts.execute, 1)
  ipcRemovalPorts.pending.set(BASE.worktreeId, background)
  accept({ removing: true })
  await Promise.resolve()
  await assert.rejects(f.custody.capture(f.resource), /admission_active/)
  ipcRemovalPorts.pending.delete(BASE.worktreeId)
  settle({ removed: true })
  assert.deepEqual(await one, await two)
  const fence = await f.custody.capture(f.resource)
  await f.custody.cancel(fence)
})

test('desktop IPC keeps remote removal on its resolved host without a local custody fallback', async () => {
  const f = runtimeFixture()
  f.custody.release('dispatch:fixture', 'owning-release')
  const fence = await f.custody.capture(f.resource)
  const remove = removalHandler(async (_context, _args, _repo, _repoId, _path, hostId) => {
    assert.equal(hostId, 'ssh:fixture')
    return { removed: true }
  })
  await remove(null, { worktreeId: BASE.worktreeId, hostId: 'ssh:fixture' })
  assert.equal(ipcRemovalPorts.counts.execute, 1)
  f.custody.check(fence)
  await f.custody.cancel(fence)
})
