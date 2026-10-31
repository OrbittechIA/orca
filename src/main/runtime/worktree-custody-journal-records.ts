import type { CustodyRecord, CustodyReceipt } from './worktree-custody-records'
import { custodyFenceOwnerIsValid as fenceOwner } from './worktree-custody-epoch-seal'
import {
  custodyResourceKey,
  type WorktreeCustodyResource,
  type WorktreeCustodyFence,
  type WorktreeCustodyOutcome
} from '../../shared/worktree/custody'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resource(value: unknown): value is WorktreeCustodyResource {
  return (
    object(value) &&
    ['worktreeId', 'path', 'instanceId', 'hostId', 'owner', 'product', 'task', 'generation'].every(
      (key) =>
        typeof value[key] === 'string' &&
        value[key].length > 0 &&
        value[key].length <= 8192 &&
        !value[key].includes('\0')
    )
  )
}

function fence(value: unknown): value is WorktreeCustodyFence {
  return (
    object(value) &&
    resource(value.resource) &&
    typeof value.token === 'string' &&
    typeof value.authorityId === 'string' &&
    typeof value.capturedAt === 'number' &&
    Number.isFinite(value.capturedAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  )
}

function outcome(value: unknown): value is WorktreeCustodyOutcome {
  return (
    object(value) &&
    resource(value.resource) &&
    typeof value.key === 'string' &&
    typeof value.state === 'string' &&
    ['dispatched', 'retired', 'unknown', 'refused'].includes(value.state) &&
    typeof value.recordedAt === 'number' &&
    Number.isFinite(value.recordedAt) &&
    (value.reason === null || typeof value.reason === 'string')
  )
}

export function custodyJournalRecord(value: unknown): value is CustodyRecord {
  if (
    !object(value) ||
    !resource(value.resource) ||
    typeof value.claim !== 'string' ||
    !(value.releaseProof === null || typeof value.releaseProof === 'string') ||
    typeof value.revoked !== 'boolean' ||
    !(
      value.releaseEpoch === undefined ||
      (typeof value.releaseEpoch === 'string' && value.releaseEpoch.length > 0)
    ) ||
    !(
      value.releaseRecoveryProof === undefined ||
      (typeof value.releaseRecoveryProof === 'string' &&
        value.releaseRecoveryProof.length > 0 &&
        value.releaseRecoveryProof.length <= 8192)
    ) ||
    !(value.fence === null || fence(value.fence)) ||
    !(value.fenceOwner === undefined || (value.fence !== null && fenceOwner(value.fenceOwner))) ||
    !(value.outcome === null || outcome(value.outcome)) ||
    !(
      value.recovery === undefined ||
      (object(value.recovery) &&
        typeof value.recovery.token === 'string' &&
        typeof value.recovery.authorityId === 'string' &&
        typeof value.recovery.proof === 'string' &&
        value.recovery.proof.length > 0 &&
        value.recovery.proof.length <= 8192 &&
        (value.recovery.fence === undefined ||
          (fence(value.recovery.fence) &&
            value.recovery.token === value.recovery.fence.token &&
            value.recovery.authorityId === value.recovery.fence.authorityId &&
            custodyResourceKey(value.recovery.fence.resource) ===
              custodyResourceKey(value.resource))))
    )
  ) {
    return false
  }
  const key = custodyResourceKey(value.resource)
  return (
    (value.fence === null || custodyResourceKey(value.fence.resource) === key) &&
    (value.outcome === null || custodyResourceKey(value.outcome.resource) === key)
  )
}

export function custodyJournalReceipt(value: unknown): value is CustodyReceipt {
  return (
    object(value) &&
    (value.state === undefined || value.state === 'retired' || value.state === 'refused') &&
    (value.fenceHash === undefined ||
      (typeof value.fenceHash === 'string' && /^[a-f0-9]{64}$/.test(value.fenceHash))) &&
    ['resourceHash', 'materialHash', 'claimHash', 'keyHash'].every(
      (key) => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key])
    ) &&
    typeof value.recordedAt === 'number' &&
    Number.isFinite(value.recordedAt) &&
    (value.reason === null || typeof value.reason === 'string') &&
    (value.proof === null || (typeof value.proof === 'string' && value.proof.length > 0))
  )
}
