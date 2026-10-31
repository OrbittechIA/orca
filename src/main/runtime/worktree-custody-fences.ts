import { randomUUID } from 'node:crypto'
import {
  custodyObservationRefusals,
  custodyResourceKey,
  WORKTREE_CUSTODY_MAX_AGE_MS,
  type WorktreeCustodyFence,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'
import {
  overlaps,
  sameFence,
  type CustodyCoverage,
  type CustodyRecord
} from './worktree-custody-records'
import { WorktreeCustodyAdmission } from './worktree-custody-admission'

export class WorktreeCustodyFences extends WorktreeCustodyAdmission {
  protected readonly grants = new Map<
    string,
    { check: () => boolean; release: () => void; resourceKey: string; terminalKey?: string }
  >()
  protected readonly busy = new Set<string>()

  async capture(resource: WorktreeCustodyResource): Promise<WorktreeCustodyFence> {
    const record = this.record(resource)
    if (this.settled(record)) {
      throw new Error('custody_material_retired')
    }
    this.assertPathAvailable(resource)
    if (
      this.liveOverlapping(resource).some(
        (entry) => !entry.revoked && entry.releaseProof && entry.releaseEpoch !== this.authorityId
      )
    ) {
      await this.recoverReleases(resource)
    }
    this.assertPathAvailable(resource)
    this.assertReleased(resource)
    const coverage = this.requireCoverage(resource)
    this.assertNoAdmissions(resource)
    const fence = {
      resource: structuredClone(record.resource),
      token: randomUUID(),
      authorityId: this.authorityId,
      capturedAt: this.now(),
      expiresAt: this.now() + WORKTREE_CUSTODY_MAX_AGE_MS
    }
    const owner = this.currentFenceOwner()
    this.commitEffects(() => {
      record.fence = fence
      if (owner) {
        record.fenceOwner = owner
      } else {
        delete record.fenceOwner
      }
    })
    try {
      const grant = await coverage.acquire(resource)
      this.grants.set(fence.token, {
        check: () => grant.check(),
        release: () => grant.release(),
        resourceKey: custodyResourceKey(resource)
      })
      this.check(fence)
      const refusals = custodyObservationRefusals(
        resource,
        await this.observe(resource),
        this.now()
      )
      if (refusals.length) {
        throw new Error(`custody_refused:${refusals.join(',')}`)
      }
      this.check(fence)
      return structuredClone(fence)
    } catch (error) {
      await this.cancel(fence)
      throw error
    }
  }

  check(fence: WorktreeCustodyFence): void {
    const record = this.record(fence.resource)
    const held = record.fence
    const now = this.now()
    if (
      !held ||
      held.token !== fence.token ||
      held.authorityId !== this.authorityId ||
      fence.authorityId !== this.authorityId ||
      !Number.isFinite(now) ||
      now < held.capturedAt ||
      now > held.expiresAt ||
      !this.coverage.has(fence.resource.owner) ||
      this.grants.get(fence.token)?.check() !== true
    ) {
      throw new Error('custody_fence_invalid')
    }
    this.assertReleased(fence.resource)
    this.assertPathAvailable(fence.resource, record)
    this.assertNoAdmissions(fence.resource)
  }

  async cancel(fence: WorktreeCustodyFence): Promise<void> {
    const record = this.record(fence.resource)
    if (
      record.recovery?.token === fence.token &&
      record.recovery.authorityId === fence.authorityId
    ) {
      return
    }
    const held = record.fence
    if (!held || !sameFence(held, fence) || record.outcome || this.pathBusy(record.resource.path)) {
      throw new Error('custody_fence_not_cancellable')
    }
    let proof: string | null = null
    if (held.authorityId !== this.authorityId) {
      const coverage = this.coverage.get(fence.resource.owner)
      if (!coverage?.recoverFence) {
        throw new Error('custody_coverage_unsupported')
      }
      const confirmation = await coverage.recoverFence(
        structuredClone(held),
        structuredClone(record.fenceOwner ?? null)
      )
      if (
        confirmation.recovered !== true ||
        typeof confirmation.proof !== 'string' ||
        !confirmation.proof ||
        confirmation.proof.length > 8192 ||
        !sameFence(confirmation.fence, held) ||
        record.fence !== held ||
        record.outcome
      ) {
        throw new Error('custody_fence_recovery_unproven')
      }
      proof = confirmation.proof
    }
    this.commitEffects(() => {
      record.fence = null
      delete record.fenceOwner
      record.recovery = {
        token: held.token,
        authorityId: held.authorityId,
        proof: proof ?? 'current-undispatched-authority'
      }
    })
    const grant = this.grants.get(fence.token)
    this.grants.delete(fence.token)
    grant?.release()
  }

  protected pathBusy(path: string): boolean {
    return [...this.busy].some((other) => overlaps(path, other))
  }

  protected assertPathAvailable(resource: WorktreeCustodyResource, own?: CustodyRecord): void {
    if (
      this.liveOverlapping(resource).some(
        (entry) => entry !== own && (entry.fence || entry.outcome)
      ) ||
      (!own && this.pathBusy(resource.path))
    ) {
      throw new Error('worktree_custody_fenced')
    }
  }

  protected requireCoverage(resource: WorktreeCustodyResource): CustodyCoverage {
    const coverage = this.coverage.get(resource.owner)
    if (!coverage || !this.supported) {
      throw new Error('custody_coverage_unsupported')
    }
    return coverage
  }
}
