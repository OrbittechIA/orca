import { custodyResourceKey } from '../../shared/worktree/custody'
import type {
  CustodyCoverage,
  CustodyRecord,
  CustodyReleaseRecovery
} from './worktree-custody-records'

export async function recoverCustodyReleases({
  records,
  authorityId,
  recoveryFor,
  persist
}: {
  records: CustodyRecord[]
  authorityId: string
  recoveryFor: (owner: string) => CustodyCoverage['recoverRelease']
  persist: () => boolean
}): Promise<void> {
  for (const record of records) {
    if (record.revoked || !record.releaseProof || record.releaseEpoch === authorityId) {
      continue
    }
    const recover = recoveryFor(record.resource.owner)
    if (!recover) {
      continue
    }
    const release: CustodyReleaseRecovery = {
      resource: structuredClone(record.resource),
      claim: record.claim,
      releaseProof: record.releaseProof,
      releaseEpoch: record.releaseEpoch ?? null,
      authorityId: authorityId
    }
    try {
      const confirmation = await recover(release)
      const bound = confirmation.release
      if (
        confirmation.confirmed !== true ||
        typeof confirmation.proof !== 'string' ||
        !confirmation.proof ||
        confirmation.proof.length > 8192 ||
        custodyResourceKey(bound.resource) !== custodyResourceKey(release.resource) ||
        bound.claim !== release.claim ||
        bound.releaseProof !== release.releaseProof ||
        bound.releaseEpoch !== release.releaseEpoch ||
        bound.authorityId !== authorityId ||
        record.revoked ||
        record.releaseProof !== release.releaseProof ||
        (record.releaseEpoch ?? null) !== release.releaseEpoch
      ) {
        continue
      }
      const previousEpoch = record.releaseEpoch
      const previousProof = record.releaseRecoveryProof
      record.releaseEpoch = authorityId
      record.releaseRecoveryProof = confirmation.proof
      let persisted = false
      try {
        persisted = persist()
      } catch {
        /* A failed recovery commit cannot renew the in-memory epoch either. */
      }
      if (!persisted) {
        if (previousEpoch === undefined) {
          delete record.releaseEpoch
        } else {
          record.releaseEpoch = previousEpoch
        }
        if (previousProof === undefined) {
          delete record.releaseRecoveryProof
        } else {
          record.releaseRecoveryProof = previousProof
        }
      }
    } catch {
      /* An unavailable owning authority cannot renew a prior release. */
    }
  }
}
