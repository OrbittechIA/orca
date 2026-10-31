import type { CustodyEpochSeal, CustodyFenceOwner } from './worktree-custody-records'

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function custodyFenceOwnerIsValid(value: unknown): value is CustodyFenceOwner {
  return (
    object(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    (value.startedAtMs === null ||
      (typeof value.startedAtMs === 'number' && Number.isFinite(value.startedAtMs))) &&
    (value.linuxStartTicks === undefined ||
      (typeof value.linuxStartTicks === 'string' && /^\d{1,32}$/.test(value.linuxStartTicks))) &&
    (value.bootId === undefined || text(value.bootId)) &&
    (value.machineIdentity === undefined || text(value.machineIdentity)) &&
    text(value.nonce) &&
    text(value.identity)
  )
}

export function custodyEpochSealIsValid(value: unknown): value is CustodyEpochSeal {
  return (
    object(value) &&
    text(value.authorityId) &&
    custodyFenceOwnerIsValid(value.owner) &&
    typeof value.recordsHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.recordsHash) &&
    typeof value.recordedAt === 'number' &&
    Number.isFinite(value.recordedAt) &&
    value.recordedAt >= 0
  )
}
