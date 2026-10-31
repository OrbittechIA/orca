import { randomUUID } from 'node:crypto'
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
}

export type CustodyJournal = {
  read: () => readonly CustodyRecord[]
  write: (records: readonly CustodyRecord[]) => void
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
}

function overlaps(left: string, right: string): boolean {
  const inside = (parent: string, child: string) => {
    const delta = relative(parent, child)
    return delta === '' || (delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta))
  }
  return inside(left, right) || inside(right, left)
}

/** Single native authority; coverage ports are installed by host code, never by RPC data. */
export class WorktreeCustodyAuthority {
  private records: CustodyRecord[]
  private readonly grants = new Map<string, { check: () => boolean; release: () => void }>()
  private readonly admissions = new Map<string, number>()
  private readonly busy = new Set<string>()
  private readonly coverage = new Map<string, CustodyCoverage>()
  private readonly observers = new Map<string, CustodyCoverage['observe']>()
  private poisoned = false
  private readonly reconciled = new Set<string>()

  constructor(
    private readonly journal: CustodyJournal,
    readonly authorityId: string,
    private readonly now: () => number = Date.now
  ) {
    this.records = structuredClone([...journal.read()])
  }

  installCoverage(producer: string, coverage: CustodyCoverage): () => void {
    if (this.coverage.has(producer)) throw new Error('custody_coverage_already_installed')
    this.coverage.set(producer, coverage)
    return () => {
      this.coverage.delete(producer)
    }
  }

  get supported(): boolean {
    return !this.poisoned && this.coverage.size > 0
  }

  installObserver(owner: string, observe: CustodyCoverage['observe']): void {
    this.observers.set(owner, observe)
  }

  /** Called before producer/consumer admission, including reservations before an async start. */
  admit(worktreeId: string, path: string): () => void {
    const matching = this.records.filter(
      (record) => record.resource.worktreeId === worktreeId || overlaps(record.resource.path, path)
    )
    if (
      this.poisoned &&
      matching.some(
        (record) => record.outcome?.state !== 'retired' && !this.reconciled.has(record.claim)
      )
    )
      throw new Error('custody_journal_unknown')
    for (const record of matching) {
      if (record.outcome?.state === 'retired' || this.reconciled.has(record.claim)) continue
      if (record.outcome || record.fence) throw new Error('worktree_custody_fenced')
    }
    const releasable = matching.filter(
      (record) => record.outcome?.state !== 'retired' && !this.reconciled.has(record.claim)
    )
    if (releasable.some((record) => record.releaseProof && !record.revoked)) {
      this.commit(() => {
        for (const record of releasable) {
          if (record.releaseProof) record.revoked = true
        }
      })
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
    const existing = this.records.find((record) => record.claim === claim)
    if (existing) {
      const requested = { ...resource, generation: existing.resource.generation }
      if (custodyResourceKey(requested) !== custodyResourceKey(existing.resource)) {
        throw new Error('custody_claim_binding_changed')
      }
      return structuredClone(existing.resource)
    }
    if (this.records.length >= 2048) throw new Error('custody_journal_full')
    const done = this.admit(resource.worktreeId, resource.path)
    try {
      const bound = { ...resource, generation: randomUUID() }
      this.commit(() => {
        this.records.push({
          resource: bound,
          claim,
          releaseProof: null,
          revoked: false,
          fence: null,
          outcome: null
        })
      })
      return structuredClone(bound)
    } finally {
      done()
    }
  }

  /** Only a trusted producer invokes this after its durable claims actually became released. */
  release(claim: string, proof: string): void {
    const record = this.records.find((entry) => entry.claim === claim)
    if (!record || !proof) throw new Error('custody_claim_unknown')
    if (record.revoked) throw new Error('custody_claim_reopened')
    if (record.releaseProof === proof) return
    if (record.releaseProof) throw new Error('custody_release_changed')
    this.commit(() => {
      record.releaseProof = proof
    })
  }

  resources(): WorktreeCustodyResource[] {
    const current = new Map<string, CustodyRecord>()
    for (const record of this.records) {
      current.set(JSON.stringify([record.resource.hostId, record.resource.path]), record)
    }
    return [...current.values()]
      .filter((record) => record.outcome?.state !== 'retired' && !this.reconciled.has(record.claim))
      .map((record) => structuredClone(record.resource))
  }

  async observe(resource: WorktreeCustodyResource): Promise<WorktreeCustodyObservation> {
    const record = this.record(resource)
    const observe = this.coverage.get(resource.owner)?.observe ?? this.observers.get(resource.owner)
    const at = this.now()
    if (!observe) {
      return {
        resource,
        observedAt: at,
        disposition: record.revoked ? 'unknown' : record.releaseProof ? 'released' : 'held',
        releaseProof: record.releaseProof,
        domains: []
      }
    }
    const observation = await observe(resource)
    return {
      ...observation,
      disposition: record.revoked ? 'unknown' : record.releaseProof ? 'released' : 'held',
      releaseProof: record.releaseProof
    }
  }

  async capture(resource: WorktreeCustodyResource): Promise<WorktreeCustodyFence> {
    const record = this.record(resource)
    if (record.fence || record.outcome || this.busy.has(record.claim)) {
      throw new Error('worktree_custody_fenced')
    }
    if (record.revoked || !record.releaseProof)
      throw new Error('custody_refused:producer_release_unproven')
    const coverage = this.requireCoverage(resource)
    this.assertNoAdmissions(resource)
    const fence = {
      resource: structuredClone(record.resource),
      token: randomUUID(),
      authorityId: this.authorityId,
      capturedAt: this.now(),
      expiresAt: this.now() + WORKTREE_CUSTODY_MAX_AGE_MS
    }
    this.commit(() => {
      record.fence = fence
    })
    try {
      const grant = await coverage.acquire(resource)
      this.grants.set(fence.token, grant)
      this.check(fence)
      const observation = await this.observe(resource)
      const refusals = custodyObservationRefusals(resource, observation, this.now())
      if (refusals.length) throw new Error(`custody_refused:${refusals.join(',')}`)
      this.check(fence)
      return structuredClone(fence)
    } catch (error) {
      this.cancel(fence)
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
      record.revoked ||
      !record.releaseProof ||
      !this.coverage.has(fence.resource.owner) ||
      this.grants.get(fence.token)?.check() !== true
    ) {
      throw new Error('custody_fence_invalid')
    }
    this.assertNoAdmissions(fence.resource)
  }

  cancel(fence: WorktreeCustodyFence): void {
    const record = this.record(fence.resource)
    if (
      record.fence?.token !== fence.token ||
      fence.authorityId !== this.authorityId ||
      record.outcome ||
      this.busy.has(record.claim)
    ) {
      throw new Error('custody_fence_not_cancellable')
    }
    // Persist before lifting admission; a failed journal write keeps the fence in place.
    this.commit(() => {
      record.fence = null
    })
    const grant = this.grants.get(fence.token)
    this.grants.delete(fence.token)
    grant?.release()
  }

  async retire(fence: WorktreeCustodyFence, key: string): Promise<WorktreeCustodyOutcome> {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new Error('custody_key_invalid')
    const record = this.record(fence.resource)
    if (record.outcome) {
      if (record.outcome.key !== key) throw new Error('custody_generation_already_dispatched')
      return structuredClone(record.outcome)
    }
    if (this.records.some((entry) => entry.outcome?.key === key)) {
      throw new Error('custody_key_binding_changed')
    }
    if (this.busy.has(record.claim)) throw new Error('custody_dispatch_in_progress')
    this.busy.add(record.claim)
    try {
      this.check(fence)
      const coverage = this.requireCoverage(fence.resource)
      const observation = await this.observe(fence.resource)
      const refusals = custodyObservationRefusals(fence.resource, observation, this.now())
      if (refusals.length) throw new Error(`custody_refused:${refusals.join(',')}`)
      this.check(fence)
      this.commit(() => {
        record.outcome = this.outcome(fence.resource, key, 'dispatched', null)
      })
      try {
        await coverage.retire(fence.resource, () => this.check(fence))
        this.commit(() => {
          record.outcome = this.outcome(fence.resource, key, 'retired', null)
        })
      } catch {
        this.commit(() => {
          record.outcome = this.outcome(fence.resource, key, 'unknown', 'reconcile_same_key')
        })
      }
      if (record.outcome?.state === 'retired') {
        const grant = this.grants.get(fence.token)
        this.grants.delete(fence.token)
        try {
          grant?.release()
        } catch {
          return { ...record.outcome, reason: 'grant_release_pending' }
        }
      }
      return structuredClone(record.outcome!)
    } finally {
      this.busy.delete(record.claim)
    }
  }

  async reconcile(
    resource: WorktreeCustodyResource,
    key: string
  ): Promise<WorktreeCustodyOutcome | null> {
    const record = this.record(resource)
    const outcome = record.outcome
    if (!outcome) return null
    if (outcome.key !== key) throw new Error('custody_key_binding_changed')
    if (outcome.state === 'retired' || this.busy.has(record.claim)) return structuredClone(outcome)
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
    ) {
      return { ...outcome, state: 'unknown', reason: 'native_outcome_unproven' }
    }
    this.reconciled.add(record.claim)
    // Read-only reconciliation never dispatches or rewrites a receipt.
    return { ...outcome, state: 'retired', reason: 'native_outcome_confirmed' }
  }

  private record(resource: WorktreeCustodyResource): CustodyRecord {
    if (this.poisoned) throw new Error('custody_journal_unknown')
    const record = this.records.find(
      (entry) => custodyResourceKey(entry.resource) === custodyResourceKey(resource)
    )
    if (!record) throw new Error('custody_resource_unknown')
    return record
  }

  private requireCoverage(resource: WorktreeCustodyResource): CustodyCoverage {
    const coverage = this.coverage.get(resource.owner)
    if (!coverage) throw new Error('custody_coverage_unsupported')
    return coverage
  }

  private assertNoAdmissions(resource: WorktreeCustodyResource): void {
    if ([...this.admissions].some(([path, count]) => count > 0 && overlaps(path, resource.path))) {
      throw new Error('custody_admission_active')
    }
  }

  private outcome(
    resource: WorktreeCustodyResource,
    key: string,
    state: WorktreeCustodyOutcome['state'],
    reason: string | null
  ): WorktreeCustodyOutcome {
    return { resource, key, state, reason, recordedAt: this.now() }
  }

  private commit(change: () => void): void {
    if (this.poisoned) throw new Error('custody_journal_unknown')
    const previous = structuredClone(this.records)
    change()
    try {
      this.journal.write(this.records)
    } catch (error) {
      this.records = previous
      this.poisoned = true
      throw error
    }
  }
}
