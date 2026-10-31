import { randomUUID } from 'node:crypto'
import {
  custodyResourceKey,
  type WorktreeCustodyResource,
  type WorktreeCustodyObservation
} from '../../shared/worktree/custody'
import {
  digest,
  overlaps,
  WorktreeCustodyAdmissionError,
  type CustodyCoverage,
  type CustodyRecord
} from './worktree-custody-records'
import { WorktreeCustodyState } from './worktree-custody-state'
import { recoverCustodyReleases } from './worktree-custody-release-recovery'

export class WorktreeCustodyAdmission extends WorktreeCustodyState {
  protected readonly admissions = new Map<string, number>()
  protected readonly observers = new Map<string, CustodyCoverage['observe']>()

  installCoverage(producer: string, coverage: CustodyCoverage): () => void {
    if (this.coverage.has(producer)) {
      throw new Error('custody_coverage_already_installed')
    }
    this.coverage.set(producer, coverage)
    return () => {
      this.coverage.delete(producer)
    }
  }

  get supported(): boolean {
    return (
      this.complete &&
      !this.admissionsClosed &&
      this.coverage.size > 0 &&
      [...this.coverage.values()].every((coverage) => typeof coverage.recoverFence === 'function')
    )
  }

  installObserver(owner: string, observe: CustodyCoverage['observe']): void {
    this.observers.set(owner, observe)
  }

  checkAdmission(worktreeId: string, path: string): void {
    if (this.admissionsClosed) {
      throw new WorktreeCustodyAdmissionError('custody_admissions_closed')
    }
    if (this.effectsUnreadable) {
      throw new WorktreeCustodyAdmissionError('custody_effects_unknown')
    }
    if (
      this.records.some(
        (record) =>
          (record.resource.worktreeId === worktreeId || overlaps(record.resource.path, path)) &&
          (record.fence || record.outcome) &&
          !this.settled(record)
      )
    ) {
      throw new WorktreeCustodyAdmissionError('worktree_custody_fenced')
    }
  }

  /** Committed quit only; closure is irreversible for this process incarnation. */
  closeAdmissions(): void {
    this.admissionsClosed = true
  }

  sealClosedEpoch(): boolean {
    if ([...this.admissions.values()].some((count) => count > 0)) {
      return false
    }
    if (this.records.some((record) => record.fence || record.outcome)) {
      return false
    }
    return this.sealClaims()
  }

  admit(worktreeId: string, path: string, reopen = true): () => void {
    this.checkAdmission(worktreeId, path)
    if (reopen) {
      let changed = false
      for (const record of this.records) {
        if (
          (record.resource.worktreeId === worktreeId || overlaps(record.resource.path, path)) &&
          !this.settled(record) &&
          record.releaseProof &&
          !record.revoked
        ) {
          record.revoked = true
          changed = true
        }
      }
      if (changed) {
        this.persistClaims()
      }
    }
    this.admissions.set(path, (this.admissions.get(path) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const count = this.admissions.get(path) ?? 0
      if (count <= 1) {
        this.admissions.delete(path)
      } else {
        this.admissions.set(path, count - 1)
      }
    }
  }

  claim(
    resource: Omit<WorktreeCustodyResource, 'generation'>,
    claim: string
  ): WorktreeCustodyResource {
    this.checkAdmission(resource.worktreeId, resource.path)
    if (
      this.effects.receipts.some(
        (receipt) => receipt.state !== 'refused' && receipt.claimHash === digest(claim)
      )
    ) {
      throw new Error('custody_claim_retired')
    }
    const existing = this.records.find((record) => record.claim === claim)
    if (existing) {
      if (
        custodyResourceKey({ ...resource, generation: existing.resource.generation }) !==
        custodyResourceKey(existing.resource)
      ) {
        throw new Error('custody_claim_binding_changed')
      }
      return structuredClone(existing.resource)
    }
    if (this.records.length >= 2048) {
      const disposable = this.records.findIndex(
        (record) =>
          !record.fence &&
          !record.outcome &&
          !record.revoked &&
          record.releaseEpoch === this.authorityId &&
          Boolean(record.releaseProof) &&
          this.liveOverlapping(record.resource).every(
            (entry) =>
              !entry.revoked &&
              entry.releaseProof &&
              entry.releaseEpoch === this.authorityId &&
              !entry.fence &&
              !entry.outcome
          )
      )
      if (disposable === -1) {
        throw new Error('custody_claims_full')
      }
      this.records.splice(disposable, 1)
    }
    const bound = { ...resource, generation: randomUUID() }
    this.records.push({
      resource: bound,
      claim,
      releaseProof: null,
      revoked: false,
      fence: null,
      outcome: null
    })
    this.persistClaims()
    return structuredClone(bound)
  }

  release(claim: string, proof: string): void {
    const record = this.records.find((entry) => entry.claim === claim)
    if (!record || !proof) {
      throw new Error('custody_claim_unknown')
    }
    if (record.revoked) {
      throw new Error('custody_claim_reopened')
    }
    if (record.releaseProof === proof) {
      return
    }
    if (record.releaseProof) {
      throw new Error('custody_release_changed')
    }
    record.releaseProof = proof
    record.releaseEpoch = this.authorityId
    this.persistClaims()
  }

  resources(): WorktreeCustodyResource[] {
    const current = new Map<string, CustodyRecord>()
    for (const record of this.records) {
      if (!this.settled(record)) {
        current.set(JSON.stringify([record.resource.hostId, record.resource.path]), record)
      }
    }
    return [...current.values()].map((record) => structuredClone(record.resource))
  }

  producerClaim(resource: WorktreeCustodyResource): string | null {
    return (
      this.records.find(
        (entry) => custodyResourceKey(entry.resource) === custodyResourceKey(resource)
      )?.claim ?? null
    )
  }

  claimedResource(claim: string): WorktreeCustodyResource | null {
    return this.records.find((entry) => entry.claim === claim)?.resource ?? null
  }

  async observe(resource: WorktreeCustodyResource): Promise<WorktreeCustodyObservation> {
    const record = this.record(resource)
    await this.recoverReleases(resource)
    const observe = this.coverage.get(resource.owner)?.observe ?? this.observers.get(resource.owner)
    const observation = observe
      ? await observe(resource)
      : { resource, observedAt: this.now(), domains: [] }
    const overlapping = this.liveOverlapping(resource)
    const disposition = overlapping.some(
      (entry) => entry.revoked || (entry.releaseProof && entry.releaseEpoch !== this.authorityId)
    )
      ? 'unknown'
      : overlapping.every((entry) => Boolean(entry.releaseProof))
        ? 'released'
        : 'held'
    return {
      ...observation,
      claim: resource.owner === 'orchestration' ? record.claim : null,
      disposition,
      releaseProof: disposition === 'released' ? record.releaseProof : null
    }
  }

  protected assertReleased(resource: WorktreeCustodyResource): void {
    if (
      this.liveOverlapping(resource).some(
        (entry) => entry.revoked || !entry.releaseProof || entry.releaseEpoch !== this.authorityId
      )
    ) {
      throw new Error('custody_refused:producer_release_unproven')
    }
  }

  protected assertNoAdmissions(resource: WorktreeCustodyResource): void {
    if ([...this.admissions].some(([path, count]) => count > 0 && overlaps(path, resource.path))) {
      throw new Error('custody_admission_active')
    }
  }

  protected recoverReleases(resource: WorktreeCustodyResource): Promise<void> {
    return recoverCustodyReleases({
      records: this.liveOverlapping(resource),
      authorityId: this.authorityId,
      recoveryFor: (owner) => this.coverage.get(owner)?.recoverRelease,
      persist: () => this.persistClaims()
    })
  }
}
