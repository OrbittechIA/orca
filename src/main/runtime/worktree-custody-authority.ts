import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import {
  custodyObservationRefusals,
  custodyResourceKey,
  WORKTREE_CUSTODY_MAX_AGE_MS,
  type WorktreeCustodyFence,
  type WorktreeCustodyObservation,
  type WorktreeCustodyOutcome,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'

export type CustodyRecord = {
  resource: WorktreeCustodyResource
  claim: string
  releaseProof: string | null
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
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function materialHash(resource: WorktreeCustodyResource): string {
  return digest(JSON.stringify([resource.hostId, resource.path, resource.instanceId]))
}

function sameFence(left: WorktreeCustodyFence, right: WorktreeCustodyFence): boolean {
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

function overlaps(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const delta = relative(parent, child)
    return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  }
  return inside(left, right) || inside(right, left)
}

/** Process-owned authority; optional claims never authorize or poison effects. */
export class WorktreeCustodyAuthority {
  private records: CustodyRecord[] = []
  private effects: CustodyState = { records: [], receipts: [] }
  private readonly grants = new Map<string, { check: () => boolean; release: () => void }>()
  private readonly admissions = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly coverage = new Map<string, CustodyCoverage>()
  private readonly observers = new Map<string, CustodyCoverage['observe']>()
  private effectsUnreadable = false
  private effectsWriteUnknown = false
  private claimsHealthy = true

  constructor(
    private readonly journal: CustodyJournal,
    readonly authorityId: string,
    private readonly now: () => number = Date.now,
    private readonly claimsJournal?: CustodyJournal
  ) {
    try {
      this.effects = structuredClone(journal.read())
      for (const record of this.effects.records) {
        if (record.outcome?.state === 'retired') {
          this.effects.receipts.push({
            resourceHash: digest(custodyResourceKey(record.resource)),
            materialHash: materialHash(record.resource),
            claimHash: digest(record.claim),
            keyHash: digest(record.outcome.key),
            recordedAt: record.outcome.recordedAt,
            reason: record.outcome.reason,
            proof: null
          })
        }
      }
      this.records = structuredClone(this.effects.records)
    } catch {
      this.effectsUnreadable = true
    }
    if (claimsJournal) {
      try {
        for (const record of claimsJournal.read().records) {
          if (
            !this.records.some((entry) => entry.claim === record.claim) &&
            !this.effects.receipts.some((receipt) => receipt.claimHash === digest(record.claim))
          ) {
            this.records.push(record)
          }
        }
      } catch {
        this.claimsHealthy = false
      }
    }
  }

  installCoverage(producer: string, coverage: CustodyCoverage): () => void {
    if (this.coverage.has(producer)) throw new Error('custody_coverage_already_installed')
    this.coverage.set(producer, coverage)
    return () => {
      this.coverage.delete(producer)
    }
  }

  get complete(): boolean {
    return !this.effectsUnreadable && !this.effectsWriteUnknown && this.claimsHealthy
  }

  get supported(): boolean {
    return (
      this.complete &&
      this.coverage.size > 0 &&
      [...this.coverage.values()].every((coverage) => typeof coverage.recoverFence === 'function')
    )
  }

  installObserver(owner: string, observe: CustodyCoverage['observe']): void {
    this.observers.set(owner, observe)
  }

  checkAdmission(worktreeId: string, path: string): void {
    if (this.effectsUnreadable) throw new WorktreeCustodyAdmissionError('custody_effects_unknown')
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
      if (changed) this.persistClaims()
    }
    this.admissions.set(path, (this.admissions.get(path) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.admissions.get(path) ?? 0
      if (count <= 1) this.admissions.delete(path)
      else this.admissions.set(path, count - 1)
    }
  }

  claim(
    resource: Omit<WorktreeCustodyResource, 'generation'>,
    claim: string
  ): WorktreeCustodyResource {
    this.checkAdmission(resource.worktreeId, resource.path)
    if (this.effects.receipts.some((receipt) => receipt.claimHash === digest(claim)))
      throw new Error('custody_claim_retired')
    const existing = this.records.find((record) => record.claim === claim)
    if (existing) {
      if (
        custodyResourceKey({ ...resource, generation: existing.resource.generation }) !==
        custodyResourceKey(existing.resource)
      )
        throw new Error('custody_claim_binding_changed')
      return structuredClone(existing.resource)
    }
    if (this.records.length >= 2048) {
      const disposable = this.records.findIndex(
        (record) => !record.fence && !record.outcome && Boolean(record.releaseProof)
      )
      if (disposable < 0) throw new Error('custody_claims_full')
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
    if (!record || !proof) throw new Error('custody_claim_unknown')
    if (record.revoked) throw new Error('custody_claim_reopened')
    if (record.releaseProof === proof) return
    if (record.releaseProof) throw new Error('custody_release_changed')
    record.releaseProof = proof
    this.persistClaims()
  }

  resources(): WorktreeCustodyResource[] {
    const current = new Map<string, CustodyRecord>()
    for (const record of this.records) {
      if (!this.settled(record))
        current.set(JSON.stringify([record.resource.hostId, record.resource.path]), record)
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
    const observe = this.coverage.get(resource.owner)?.observe ?? this.observers.get(resource.owner)
    const observation = observe
      ? await observe(resource)
      : { resource, observedAt: this.now(), domains: [] }
    const overlapping = this.liveOverlapping(resource)
    const disposition = overlapping.some((entry) => entry.revoked)
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

  async capture(resource: WorktreeCustodyResource): Promise<WorktreeCustodyFence> {
    const record = this.record(resource)
    if (this.settled(record)) throw new Error('custody_material_retired')
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
    this.commitEffects(() => {
      record.fence = fence
    })
    try {
      const grant = await coverage.acquire(resource)
      this.grants.set(fence.token, grant)
      this.check(fence)
      const refusals = custodyObservationRefusals(
        resource,
        await this.observe(resource),
        this.now()
      )
      if (refusals.length) throw new Error(`custody_refused:${refusals.join(',')}`)
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
    )
      throw new Error('custody_fence_invalid')
    this.assertReleased(fence.resource)
    this.assertPathAvailable(fence.resource, record)
    this.assertNoAdmissions(fence.resource)
  }

  async cancel(fence: WorktreeCustodyFence): Promise<void> {
    const record = this.record(fence.resource)
    if (record.recovery?.token === fence.token && record.recovery.authorityId === fence.authorityId)
      return
    const held = record.fence
    if (!held || !sameFence(held, fence) || record.outcome || this.pathBusy(record.resource.path))
      throw new Error('custody_fence_not_cancellable')
    let proof: string | null = null
    if (held.authorityId !== this.authorityId) {
      const coverage = this.coverage.get(fence.resource.owner)
      if (!coverage?.recoverFence) throw new Error('custody_coverage_unsupported')
      const confirmation = await coverage.recoverFence(structuredClone(held))
      if (
        confirmation.recovered !== true ||
        !confirmation.proof ||
        !sameFence(confirmation.fence, held) ||
        record.fence !== held ||
        record.outcome
      )
        throw new Error('custody_fence_recovery_unproven')
      proof = confirmation.proof
    }
    this.commitEffects(() => {
      record.fence = null
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

  async retire(fence: WorktreeCustodyFence, key: string): Promise<WorktreeCustodyOutcome> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new Error('custody_key_invalid')
    const receipt = this.receipt(fence.resource, key)
    if (receipt) return receipt
    const record = this.record(fence.resource)
    if (record.outcome) {
      if (record.outcome.key !== key) throw new Error('custody_generation_already_dispatched')
      return structuredClone(record.outcome)
    }
    if (
      this.records.some((entry) => entry.outcome?.key === key) ||
      this.effects.receipts.some((entry) => entry.keyHash === digest(key))
    )
      throw new Error('custody_key_binding_changed')
    this.assertPathAvailable(fence.resource, record)
    if (this.pathBusy(record.resource.path)) throw new Error('custody_dispatch_in_progress')
    this.busy.add(record.resource.path)
    try {
      this.check(fence)
      const coverage = this.requireCoverage(fence.resource)
      const refusals = custodyObservationRefusals(
        fence.resource,
        await this.observe(fence.resource),
        this.now()
      )
      if (refusals.length) throw new Error(`custody_refused:${refusals.join(',')}`)
      this.check(fence)
      this.commitEffects(() => {
        record.outcome = this.outcome(fence.resource, key, 'dispatched', null)
      })
      try {
        await coverage.retire(fence.resource, () => this.check(fence))
      } catch {
        const unknown = this.outcome(fence.resource, key, 'unknown', 'reconcile_same_key')
        this.commitEffects(() => {
          record.outcome = unknown
        })
        return structuredClone(unknown)
      }
      const result = this.outcome(fence.resource, key, 'retired', null)
      this.commitReceipt(record, result, null)
      const grant = this.grants.get(fence.token)
      this.grants.delete(fence.token)
      try {
        grant?.release()
      } catch {
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
    if (receipt) return receipt
    const record = this.record(resource)
    const outcome = record.outcome
    if (!outcome) return null
    if (outcome.key !== key) throw new Error('custody_key_binding_changed')
    if (outcome.state === 'retired' || this.pathBusy(resource.path)) return structuredClone(outcome)
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
      !confirmation.proof ||
      confirmation.key !== key ||
      custodyResourceKey(confirmation.resource) !== custodyResourceKey(resource)
    )
      return { ...outcome, state: 'unknown', reason: 'native_outcome_unproven' }
    const result = { ...outcome, state: 'retired' as const, reason: 'native_outcome_confirmed' }
    this.commitReceipt(record, result, confirmation.proof)
    const token = record.fence?.token
    if (token) {
      const grant = this.grants.get(token)
      this.grants.delete(token)
      grant?.release()
    }
    return result
  }

  private settled(record: CustodyRecord): boolean {
    if (record.outcome?.state === 'retired') return true
    if (this.effects.receipts.length === 0) return false
    const resourceHash = digest(custodyResourceKey(record.resource))
    const material = !record.fence && !record.outcome ? materialHash(record.resource) : null
    return this.effects.receipts.some(
      (receipt) => receipt.resourceHash === resourceHash || receipt.materialHash === material
    )
  }

  private liveOverlapping(resource: WorktreeCustodyResource): CustodyRecord[] {
    return this.records.filter(
      (entry) =>
        entry.resource.hostId === resource.hostId &&
        overlaps(entry.resource.path, resource.path) &&
        !this.settled(entry)
    )
  }

  private pathBusy(path: string): boolean {
    return [...this.busy].some((other) => overlaps(path, other))
  }

  private assertPathAvailable(resource: WorktreeCustodyResource, own?: CustodyRecord): void {
    if (
      this.liveOverlapping(resource).some(
        (entry) => entry !== own && (entry.fence || entry.outcome)
      ) ||
      (!own && this.pathBusy(resource.path))
    )
      throw new Error('worktree_custody_fenced')
  }

  private assertReleased(resource: WorktreeCustodyResource): void {
    if (this.liveOverlapping(resource).some((entry) => entry.revoked || !entry.releaseProof))
      throw new Error('custody_refused:producer_release_unproven')
  }

  private record(resource: WorktreeCustodyResource): CustodyRecord {
    if (this.effectsUnreadable || this.effectsWriteUnknown)
      throw new Error('custody_effects_unknown')
    const record = this.records.find(
      (entry) => custodyResourceKey(entry.resource) === custodyResourceKey(resource)
    )
    if (!record) throw new Error('custody_resource_unknown')
    return record
  }

  private receipt(resource: WorktreeCustodyResource, key: string): WorktreeCustodyOutcome | null {
    if (this.effectsUnreadable) throw new Error('custody_effects_unknown')
    const resourceHash = digest(custodyResourceKey(resource))
    const receipt = this.effects.receipts.find((entry) => entry.resourceHash === resourceHash)
    if (!receipt) return null
    if (receipt.keyHash !== digest(key)) throw new Error('custody_generation_already_dispatched')
    return {
      resource,
      key,
      state: 'retired',
      recordedAt: receipt.recordedAt,
      reason: receipt.reason
    }
  }

  private requireCoverage(resource: WorktreeCustodyResource): CustodyCoverage {
    const coverage = this.coverage.get(resource.owner)
    if (!coverage || !this.supported) throw new Error('custody_coverage_unsupported')
    return coverage
  }

  private assertNoAdmissions(resource: WorktreeCustodyResource): void {
    if ([...this.admissions].some(([path, count]) => count > 0 && overlaps(path, resource.path)))
      throw new Error('custody_admission_active')
  }

  private outcome(
    resource: WorktreeCustodyResource,
    key: string,
    state: WorktreeCustodyOutcome['state'],
    reason: string | null
  ): WorktreeCustodyOutcome {
    return { resource, key, state, reason, recordedAt: this.now() }
  }

  private persistClaims(): void {
    if (
      !this.claimsJournal ||
      (this.coverage.size === 0 &&
        this.effects.records.length === 0 &&
        this.effects.receipts.length === 0)
    )
      return
    try {
      this.claimsJournal.write({
        records: this.records.filter((record) => !record.fence && !record.outcome),
        receipts: []
      })
    } catch {
      this.claimsHealthy = false
    }
  }

  private commitReceipt(
    record: CustodyRecord,
    outcome: WorktreeCustodyOutcome,
    proof: string | null
  ): void {
    this.commitEffects(() => {
      record.outcome = outcome
      this.effects.receipts.push({
        resourceHash: digest(custodyResourceKey(record.resource)),
        materialHash: materialHash(record.resource),
        claimHash: digest(record.claim),
        keyHash: digest(outcome.key),
        recordedAt: outcome.recordedAt,
        reason: outcome.reason,
        proof
      })
    })
    this.records = this.records.filter((entry) => entry !== record)
  }

  private commitEffects(change: () => void): void {
    if (this.effectsUnreadable || this.effectsWriteUnknown)
      throw new Error('custody_effects_unknown')
    const previous = structuredClone(this.records)
    const previousEffects = structuredClone(this.effects)
    change()
    const candidate = {
      records: this.records.filter(
        (record) =>
          !this.settled(record) &&
          (record.fence !== null || record.outcome !== null || record.recovery !== undefined)
      ),
      receipts: this.effects.receipts
    }
    try {
      this.journal.write(candidate)
      this.effects = structuredClone(candidate)
    } catch (error) {
      const uncertain = structuredClone(candidate.records)
      this.records = previous
      this.effects = previousEffects
      if (!(error instanceof Error && error.message === 'custody_journal_full')) {
        for (const record of uncertain) {
          if (
            !this.records.some(
              (entry) => entry.claim === record.claim && (entry.fence || entry.outcome)
            )
          )
            this.records.push(record)
        }
        this.effectsWriteUnknown = true
      }
      throw error
    }
  }
}
