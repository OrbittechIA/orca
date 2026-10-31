import assert from 'node:assert/strict'
import { test } from 'vitest'
import { moduleFromSource } from './worktree-custody-fixture.mjs'
import { KEY, nativePorts } from './worktree-custody-fixture.mjs'
import { providerCheckout, providerFixture } from './worktree-custody-native-fixture.mjs'
import { runtimePorts } from './worktree-custody-runtime-fixture.mjs'

await moduleFromSource('selection-rounds.mjs', './worktree-custody-selection-rounds.ts', {
  '../../shared/worktree/custody': './custody.mjs'
})
const { WorktreeCustodySelections, nativeWorktreeCustodySelections } = await moduleFromSource(
  'selections.mjs',
  './worktree-custody-selections.ts',
  {
    './worktree-custody-runtime': './native-ports.mjs',
    '../../shared/app-environment': './runtime-ports.mjs',
    './worktree-custody-selection-rounds': './selection-rounds.mjs'
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
  const selections = new WorktreeCustodySelections((id) => {
    admissions.push(id)
    return () => {}
  })
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
  const selections = new WorktreeCustodySelections(() => () => {})
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
  const selections = new WorktreeCustodySelections((id) => {
    if (id === 'retiring') {
      throw new Error('worktree_custody_fenced')
    }
    reservations++
    return () => reservations--
  })
  const close = selections.open('desktop')
  selections.watch('desktop', '11111111-1111-4111-8111-111111111111', () => {})
  selections.report('desktop', ['existing'])
  assert.throws(() => selections.report('desktop', ['new', 'retiring']), /fenced/)
  assert.equal(reservations, 0)
  assert.equal(selections.selects('existing'), true)
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
