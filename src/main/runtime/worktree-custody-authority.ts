import { nativeWorktreePreEffectRefusal } from './worktree-custody-retirement'
import {
  custodyObservationRefusals,
  custodyResourceKey,
  type WorktreeCustodyFence,
  type WorktreeCustodyOutcome,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'
import { digest, type CustodyRetirementConfirmation } from './worktree-custody-records'
import { WorktreeCustodyFences } from './worktree-custody-fences'

export { WorktreeCustodyAdmissionError } from './worktree-custody-records'
export type {
  CustodyRecord,
  CustodyReceipt,
  CustodyState,
  CustodyJournal,
  CustodyRetirementConfirmation,
  CustodyReleaseRecovery,
  CustodyCoverage
} from './worktree-custody-records'

export class WorktreeCustodyAuthority extends WorktreeCustodyFences {
  override resources(): WorktreeCustodyResource[] {
    this.releaseTerminalGrants()
    return super.resources()
  }

  override async observe(resource: WorktreeCustodyResource) {
    this.releaseTerminalGrants(resource)
    return super.observe(resource)
  }

  override async capture(resource: WorktreeCustodyResource): Promise<WorktreeCustodyFence> {
    this.releaseTerminalGrants(resource)
    return super.capture(resource)
  }

  async retire(fence: WorktreeCustodyFence, key: string): Promise<WorktreeCustodyOutcome> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
      throw new Error('custody_key_invalid')
    }
    const receipt = this.receipt(fence.resource, key)
    if (receipt) {
      this.releaseTerminalGrants(fence.resource, key)
      return receipt
    }
    const pending = this.pendingOutcome(fence.resource, key)
    if (pending) {
      return pending
    }
    const record = this.record(fence.resource)
    if (record.outcome) {
      if (record.outcome.key !== key) {
        throw new Error('custody_generation_already_dispatched')
      }
      return structuredClone(record.outcome)
    }
    if (
      this.records.some((entry) => entry.outcome?.key === key) ||
      this.effects.receipts.some((entry) => entry.keyHash === digest(key))
    ) {
      throw new Error('custody_key_binding_changed')
    }
    this.assertPathAvailable(fence.resource, record)
    if (this.pathBusy(record.resource.path)) {
      throw new Error('custody_dispatch_in_progress')
    }
    this.busy.add(record.resource.path)
    try {
      this.check(fence)
      const coverage = this.requireCoverage(fence.resource)
      const refusals = custodyObservationRefusals(
        fence.resource,
        await this.observe(fence.resource),
        this.now()
      )
      if (refusals.length) {
        throw new Error(`custody_refused:${refusals.join(',')}`)
      }
      this.check(fence)
      this.commitEffects(() => {
        record.outcome = this.outcome(fence.resource, key, 'dispatched', null)
      })
      let result: WorktreeCustodyOutcome
      let proof: string | null = null
      try {
        await coverage.retire(fence.resource, () => this.check(fence))
        result = this.outcome(fence.resource, key, 'retired', null)
      } catch (error) {
        proof = nativeWorktreePreEffectRefusal(coverage.retire, error, fence.resource)
        if (proof) {
          result = this.outcome(fence.resource, key, 'refused', 'custody_pre_effect_refused')
        } else {
          const unknown = this.outcome(fence.resource, key, 'unknown', 'reconcile_same_key')
          try {
            this.commitEffects(() => {
              record.outcome = unknown
            })
          } catch {
            return { ...unknown, reason: 'native_outcome_commit_pending' }
          }
          return unknown
        }
      }
      try {
        this.commitReceipt(record, result, proof)
      } catch {
        return this.outcome(fence.resource, key, 'unknown', 'native_outcome_commit_pending')
      }
      const grant = this.grants.get(fence.token)
      if (grant) {
        grant.terminalKey = key
      }
      const released = this.releaseTerminalGrants(fence.resource, key)
      if (!released && result.state === 'retired') {
        return { ...result, reason: 'grant_release_pending' }
      }
      return result
    } finally {
      this.busy.delete(record.resource.path)
    }
  }

  async reconcile(
    resource: WorktreeCustodyResource,
    key: string
  ): Promise<WorktreeCustodyOutcome | null> {
    const receipt = this.receipt(resource, key)
    if (receipt) {
      this.releaseTerminalGrants(resource, key)
      return receipt
    }
    const pending = this.pendingOutcome(resource, key)
    if (pending) {
      return pending
    }
    const record = this.record(resource)
    const outcome = record.outcome
    if (!outcome) {
      return null
    }
    if (outcome.key !== key) {
      throw new Error('custody_key_binding_changed')
    }
    if (outcome.state === 'retired' || this.pathBusy(resource.path)) {
      return structuredClone(outcome)
    }
    const coverage = this.coverage.get(resource.owner)
    let confirmation: CustodyRetirementConfirmation | null = null
    try {
      confirmation = coverage ? await coverage.reconcile(structuredClone(outcome)) : null
    } catch {
      return { ...outcome, state: 'unknown', reason: 'native_outcome_unavailable' }
    }
    if (
      !confirmation ||
      confirmation.confirmed !== true ||
      typeof confirmation.proof !== 'string' ||
      !confirmation.proof ||
      confirmation.key !== key ||
      custodyResourceKey(confirmation.resource) !== custodyResourceKey(resource)
    ) {
      return { ...outcome, state: 'unknown', reason: 'native_outcome_unproven' }
    }
    const result = { ...outcome, state: 'retired' as const, reason: 'native_outcome_confirmed' }
    if (confirmation.proof.length > 8192) {
      return { ...outcome, state: 'unknown', reason: 'native_outcome_proof_oversized' }
    }
    try {
      this.commitReceipt(record, result, confirmation.proof)
    } catch {
      return { ...outcome, state: 'unknown', reason: 'native_outcome_commit_pending' }
    }
    const token = record.fence?.token
    if (token) {
      const grant = this.grants.get(token)
      if (grant) {
        grant.terminalKey = key
      }
      this.releaseTerminalGrants(resource, key)
    }
    return result
  }

  private pendingOutcome(
    resource: WorktreeCustodyResource,
    key: string
  ): WorktreeCustodyOutcome | null {
    if (!this.effectsWriteUnknown) {
      return null
    }
    const outcome = this.records.find(
      (entry) => custodyResourceKey(entry.resource) === custodyResourceKey(resource)
    )?.outcome
    if (!outcome) {
      return null
    }
    if (outcome.key !== key) {
      throw new Error('custody_generation_already_dispatched')
    }
    return { ...outcome, state: 'unknown', reason: 'native_outcome_commit_pending' }
  }

  private releaseTerminalGrants(resource?: WorktreeCustodyResource, key?: string): boolean {
    const resourceKey = resource ? custodyResourceKey(resource) : null
    let released = true
    for (const [token, grant] of this.grants) {
      if (
        !grant.terminalKey ||
        (resourceKey !== null && grant.resourceKey !== resourceKey) ||
        (key !== undefined && grant.terminalKey !== key)
      ) {
        continue
      }
      try {
        grant.release()
        this.grants.delete(token)
      } catch {
        released = false
        console.warn('[worktree-custody] native grant release pending')
      }
    }
    return released
  }

  private receipt(resource: WorktreeCustodyResource, key: string): WorktreeCustodyOutcome | null {
    if (this.effectsUnreadable) {
      throw new Error('custody_effects_unknown')
    }
    const resourceHash = digest(custodyResourceKey(resource))
    const keyHash = digest(key)
    const receipt = this.effects.receipts.find((entry) => entry.keyHash === keyHash)
    if (receipt) {
      if (receipt.resourceHash !== resourceHash) {
        throw new Error('custody_key_binding_changed')
      }
      return {
        resource,
        key,
        state: receipt.state ?? 'retired',
        recordedAt: receipt.recordedAt,
        reason: receipt.reason
      }
    }
    if (
      this.effects.receipts.some(
        (entry) => entry.resourceHash === resourceHash && entry.state !== 'refused'
      )
    ) {
      throw new Error('custody_generation_already_dispatched')
    }
    return null
  }

  private outcome(
    resource: WorktreeCustodyResource,
    key: string,
    state: WorktreeCustodyOutcome['state'],
    reason: string | null
  ): WorktreeCustodyOutcome {
    return { resource, key, state, reason, recordedAt: this.now() }
  }
}
