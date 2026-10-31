import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'
import { KEY, nativePorts } from './worktree-custody-fixture.mjs'
import { providerCheckout, providerFixture } from './worktree-custody-native-fixture.mjs'

test('prepared whole-checkout policy admits a complete larger inventory as one effect', async () => {
  const checkout = providerCheckout('whole-checkout')
  for (let index = 0; index < 2050; index++) {
    writeFileSync(join(checkout, `tracked-${index}`), 'retained-by-fixture-branch')
  }
  const f = await providerFixture(checkout, {
    checkoutPolicy: {
      id: 'whole-checkout-v2',
      maxEntries: 250_000,
      maxFiles: 200_000,
      maxAllocatedBytes: 16 * 1024 ** 3,
      maxDurationMs: 25_000,
      maxDepth: 128
    }
  })
  let effects = 0
  // Source fixture only: this counts the fixed native call; it is not production Git proof.
  nativePorts.setRemove(async () => {
    effects++
  })
  const fence = await f.authority.capture(f.resource)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'retired')
  assert.equal(effects, 1)
  assert.equal((await f.authority.retire(fence, KEY)).state, 'retired')
  assert.equal(effects, 1)
})
