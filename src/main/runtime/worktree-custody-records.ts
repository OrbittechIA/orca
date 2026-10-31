import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import {
  custodyResourceKey,
  type WorktreeCustodyFence,
  type WorktreeCustodyObservation,
  type WorktreeCustodyOutcome,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'

export type CustodyRecord = {
  resource: WorktreeCustodyResource
  claim: string
  releaseProof: string | null
  releaseEpoch?: string
  releaseRecoveryProof?: string
  revoked: boolean
  fence: WorktreeCustodyFence | null
  outcome: WorktreeCustodyOutcome | null
  recovery?: { token: string; authorityId: string; proof: string }
}

export type CustodyReceipt = {
  resourceHash: string
  materialHash: string
  claimHash: string
  keyHash: string
  recordedAt: number
  reason: string | null
  proof: string | null
  state?: 'retired' | 'refused'
}

export type CustodyState = { records: CustodyRecord[]; receipts: CustodyReceipt[] }

export type CustodyJournal = {
  read: () => CustodyState
  write: (state: CustodyState) => void
}

export type CustodyRetirementConfirmation = Readonly<{
  resource: WorktreeCustodyResource
  key: string
  confirmed: boolean
  proof: string | null
}>

export type CustodyReleaseRecovery = Readonly<{
  resource: WorktreeCustodyResource
  claim: string
  releaseProof: string
  releaseEpoch: string | null
  authorityId: string
}>

export type CustodyCoverage = {
  observe: (resource: WorktreeCustodyResource) => Promise<WorktreeCustodyObservation>
  acquire: (resource: WorktreeCustodyResource) => Promise<{
    check: () => boolean
    release: () => void
  }>
  retire: (resource: WorktreeCustodyResource, check: () => void) => Promise<void>
  reconcile: (outcome: WorktreeCustodyOutcome) => Promise<CustodyRetirementConfirmation>
  recoverFence: (fence: WorktreeCustodyFence) => Promise<{
    fence: WorktreeCustodyFence
    recovered: boolean
    proof: string | null
  }>
  recoverRelease?: (release: CustodyReleaseRecovery) => Promise<{
    release: CustodyReleaseRecovery
    confirmed: boolean
    proof: string | null
  }>
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function materialHash(resource: WorktreeCustodyResource): string {
  return digest(JSON.stringify([resource.hostId, resource.path, resource.instanceId]))
}

export function sameFence(left: WorktreeCustodyFence, right: WorktreeCustodyFence): boolean {
  return (
    custodyResourceKey(left.resource) === custodyResourceKey(right.resource) &&
    left.token === right.token &&
    left.authorityId === right.authorityId &&
    left.capturedAt === right.capturedAt &&
    left.expiresAt === right.expiresAt
  )
}

export class WorktreeCustodyAdmissionError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'WorktreeCustodyAdmissionError'
  }
}

/** Only the fixed native port's preflight can certify that removal was never entered. */
export class CustodyPreEffectRefusal extends Error {
  readonly proof = `native-preflight:${randomUUID()}`

  constructor(
    readonly resource: WorktreeCustodyResource,
    cause: unknown
  ) {
    super('custody_pre_effect_refused', { cause })
    this.name = 'CustodyPreEffectRefusal'
  }
}

export function overlaps(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const delta = relative(parent, child)
    return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  }
  return inside(left, right) || inside(right, left)
}
