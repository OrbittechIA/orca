import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import {
  custodyResourceKey,
  type WorktreeCustodyFence,
  type WorktreeCustodyObservation,
  type WorktreeCustodyOutcome,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'

/** Exclusive profile-lock record held by the incarnation that captured a fence. */
export type CustodyFenceOwner = {
  pid: number
  startedAtMs: number | null
  linuxStartTicks?: string
  bootId?: string
  nonce: string
  identity: string
  machineIdentity?: string
}

export type CustodyRecord = {
  resource: WorktreeCustodyResource
  claim: string
  releaseProof: string | null
  releaseEpoch?: string
  releaseRecoveryProof?: string
  revoked: boolean
  fence: WorktreeCustodyFence | null
  /** Private witness; older readers ignore it. */
  fenceOwner?: CustodyFenceOwner
  outcome: WorktreeCustodyOutcome | null
  recovery?: { token: string; authorityId: string; proof: string; fence?: WorktreeCustodyFence }
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
  fenceHash?: string
}

export type CustodyEpochSeal = {
  authorityId: string
  owner: CustodyFenceOwner
  recordsHash: string
  recordedAt: number
}

export type CustodyState = {
  records: CustodyRecord[]
  receipts: CustodyReceipt[]
  clientCancellations?: { fenceHash: string; proofHash: string }[]
  epochSeal?: CustodyEpochSeal
}

export const MAX_CLIENT_CANCELLATIONS = 16384

export function custodyClientCancellationsValid(
  value: unknown
): value is CustodyState['clientCancellations'] {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_CLIENT_CANCELLATIONS &&
      value.every(
        (entry: unknown) =>
          typeof entry === 'object' &&
          entry !== null &&
          'fenceHash' in entry &&
          typeof entry.fenceHash === 'string' &&
          /^[a-f0-9]{64}$/.test(entry.fenceHash) &&
          'proofHash' in entry &&
          typeof entry.proofHash === 'string' &&
          /^[a-f0-9]{64}$/.test(entry.proofHash)
      ))
  )
}

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
  acquire: (
    resource: WorktreeCustodyResource,
    fence?: WorktreeCustodyFence
  ) => Promise<{
    check: () => boolean
    release: () => void
  }>
  settleClientFence?: (fence: WorktreeCustodyFence) => void
  /** `key` is the dispatched outcome key; providers written for two arguments ignore it. */
  retire: (resource: WorktreeCustodyResource, check: () => void, key?: string) => Promise<void>
  reconcile: (outcome: WorktreeCustodyOutcome) => Promise<CustodyRetirementConfirmation>
  recoverFence: (
    fence: WorktreeCustodyFence,
    owner: CustodyFenceOwner | null
  ) => Promise<{
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

export function custodyFenceHash(fence: WorktreeCustodyFence): string {
  return digest(
    JSON.stringify([
      custodyResourceKey(fence.resource),
      fence.token,
      fence.authorityId,
      fence.capturedAt,
      fence.expiresAt
    ])
  )
}

export class WorktreeCustodyAdmissionError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'WorktreeCustodyAdmissionError'
  }
}

export function overlaps(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const delta = relative(parent, child)
    return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  }
  return inside(left, right) || inside(right, left)
}
