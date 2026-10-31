export const WORKTREE_CUSTODY_CAPABILITY = 'worktree.custody.no-stop.v1' as const
export const WORKTREE_CUSTODY_MAX_AGE_MS = 30_000

export const WORKTREE_CUSTODY_DOMAINS = [
  'terminal',
  'structured-session',
  'dispatch',
  'recovery',
  'workspace',
  'registered-consumer',
  'external-consumer',
  'preservation'
] as const

export type WorktreeCustodyDomain = (typeof WORKTREE_CUSTODY_DOMAINS)[number]

export type WorktreeCustodyResource = Readonly<{
  worktreeId: string
  path: string
  instanceId: string
  hostId: string
  owner: string
  product: string
  task: string
  generation: string
}>

export function custodyResourceKey(resource: WorktreeCustodyResource): string {
  return JSON.stringify([
    resource.worktreeId,
    resource.path,
    resource.instanceId,
    resource.hostId,
    resource.owner,
    resource.product,
    resource.task,
    resource.generation
  ])
}

export type WorktreeCustodyObservation = Readonly<{
  resource: WorktreeCustodyResource
  /** Absent on earlier hosts; only the native authority binds the enrolling producer claim. */
  claim?: string | null
  observedAt: number
  disposition: 'held' | 'released' | 'unknown'
  releaseProof: string | null
  domains: readonly Readonly<{
    domain: WorktreeCustodyDomain
    observedAt: number
    complete: boolean
    active: boolean | null
    held: boolean | null
    proof: string | null
  }>[]
}>

export type WorktreeCustodyFence = Readonly<{
  resource: WorktreeCustodyResource
  token: string
  authorityId: string
  capturedAt: number
  expiresAt: number
}>

export type WorktreeCustodyOutcome = Readonly<{
  resource: WorktreeCustodyResource
  key: string
  state: 'dispatched' | 'retired' | 'unknown' | 'refused'
  recordedAt: number
  reason: string | null
}>

export function custodyObservationRefusals(
  resource: WorktreeCustodyResource,
  observation: WorktreeCustodyObservation,
  now: number
): string[] {
  const reasons: string[] = []
  const fresh = (at: number) =>
    Number.isFinite(now) &&
    Number.isFinite(at) &&
    now >= at &&
    now - at <= WORKTREE_CUSTODY_MAX_AGE_MS
  if (custodyResourceKey(resource) !== custodyResourceKey(observation.resource)) {
    reasons.push('resource_changed')
  }
  if (!fresh(observation.observedAt)) {
    reasons.push('observation_stale')
  }
  if (observation.disposition !== 'released' || !observation.releaseProof) {
    reasons.push('producer_release_unproven')
  }
  for (const domain of WORKTREE_CUSTODY_DOMAINS) {
    const matches = observation.domains.filter((entry) => entry.domain === domain)
    const entry = matches[0]
    if (
      matches.length !== 1 ||
      !entry ||
      !fresh(entry.observedAt) ||
      entry.complete !== true ||
      entry.active !== false ||
      entry.held !== false ||
      !entry.proof
    ) {
      reasons.push(`${domain}_unproven_or_held`)
    }
  }
  return reasons
}
