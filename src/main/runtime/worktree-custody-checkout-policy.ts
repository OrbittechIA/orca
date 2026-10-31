export type CheckoutRetirementPolicy = Readonly<{
  id: string
  maxEntries: number
  maxFiles: number
  maxAllocatedBytes: number
  maxDurationMs: number
  maxDepth: number
}>

export const LEGACY_CHECKOUT_RETIREMENT_POLICY: CheckoutRetirementPolicy = Object.freeze({
  id: 'bounded-checkout-v1',
  maxEntries: 4096,
  maxFiles: 2048,
  maxAllocatedBytes: 1024 ** 3,
  maxDurationMs: 10_000,
  maxDepth: 128
})

/** Prepared Core contract amendment; host adoption must qualify this whole-resource policy. */
export const WHOLE_CHECKOUT_RETIREMENT_POLICY: CheckoutRetirementPolicy = Object.freeze({
  id: 'whole-checkout-v2',
  maxEntries: 250_000,
  maxFiles: 200_000,
  maxAllocatedBytes: 16 * 1024 ** 3,
  maxDurationMs: 25_000,
  maxDepth: 128
})

export function resolveCheckoutRetirementPolicy(
  requested: CheckoutRetirementPolicy = LEGACY_CHECKOUT_RETIREMENT_POLICY
): CheckoutRetirementPolicy {
  const policy = [LEGACY_CHECKOUT_RETIREMENT_POLICY, WHOLE_CHECKOUT_RETIREMENT_POLICY].find(
    (candidate) =>
      candidate.id === requested.id &&
      candidate.maxEntries === requested.maxEntries &&
      candidate.maxFiles === requested.maxFiles &&
      candidate.maxAllocatedBytes === requested.maxAllocatedBytes &&
      candidate.maxDurationMs === requested.maxDurationMs &&
      candidate.maxDepth === requested.maxDepth
  )
  if (!policy) {
    throw new Error('custody_checkout_policy_unrecognized')
  }
  return policy
}
