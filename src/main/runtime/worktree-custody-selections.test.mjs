import assert from 'node:assert/strict'
import { test } from 'vitest'
import { moduleFromSource } from './worktree-custody-fixture.mjs'
import { KEY, nativePorts } from './worktree-custody-fixture.mjs'
import { providerCheckout, providerFixture } from './worktree-custody-native-fixture.mjs'
import { runtimePorts } from './worktree-custody-runtime-fixture.mjs'

const { WorktreeCustodySelections, nativeWorktreeCustodySelections } = await moduleFromSource(
  'selections.mjs',
  './worktree-custody-selections.ts',
  {
    './worktree-custody-runtime': './native-ports.mjs',
    '../../shared/app-environment': './runtime-ports.mjs'
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
  selections.report('desktop', ['existing'])
  assert.throws(() => selections.report('desktop', ['new', 'retiring']), /fenced/)
  assert.equal(reservations, 0)
  assert.equal(selections.selects('existing'), true)
  assert.equal(selections.selects('new'), false)
  close()
})

test('the composed provider refuses a transient late client before the fixed Git effect', async () => {
  const selections = new WorktreeCustodySelections(() => () => {})
  const f = await providerFixture(providerCheckout('late-selection'), {
    pairedSelection: selections
  })
  let effects = 0
  nativePorts.setRemove(async () => {
    effects++
  })
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
