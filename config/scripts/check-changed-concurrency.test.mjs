import { expect, it } from 'vitest'
import { resolveCheckConcurrency } from './check-changed.mjs'

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
