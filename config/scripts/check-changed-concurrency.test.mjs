import { expect, it } from 'vitest'
import { resolveCheckConcurrency, runPool } from './check-changed.mjs'

it('honors the explicit worker limit for the whole check pool', () => {
  expect(resolveCheckConcurrency(128, '1')).toBe(1)
  expect(resolveCheckConcurrency(8, '2')).toBe(2)
  expect(resolveCheckConcurrency(1, '1')).toBe(1)
})

it('preserves the default pool and never raises it for an explicit cap', () => {
  expect(resolveCheckConcurrency(8, null)).toBe(3)
  expect(resolveCheckConcurrency(24, undefined)).toBe(8)
  expect(resolveCheckConcurrency(8, '8')).toBe(3)
})

it('keeps one heavyweight gate active while preserving its two test workers', async () => {
  const gates = Array.from({ length: 8 }, (_, id) => ({ id, testWorkers: 2 }))
  let active = 0
  let peak = 0
  const seen = []
  const completed = await runPool(gates, resolveCheckConcurrency(24, 2, '1'), async (gate) => {
    active += 1
    peak = Math.max(peak, active)
    seen.push(gate.testWorkers)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return gate.id
  })
  expect(peak).toBe(1)
  expect(seen).toEqual(Array(8).fill(2))
  expect(completed).toEqual(gates.map((gate) => gate.id))
})
