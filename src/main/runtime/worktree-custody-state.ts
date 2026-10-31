import {
  custodyResourceKey,
  type WorktreeCustodyResource,
  type WorktreeCustodyOutcome
} from '../../shared/worktree/custody'
import {
  digest,
  materialHash,
  overlaps,
  type CustodyRecord,
  type CustodyState,
  type CustodyJournal,
  type CustodyCoverage,
  type CustodyFenceOwner,
  type CustodyEpochSeal
} from './worktree-custody-records'

export class WorktreeCustodyState {
  protected readonly coverage = new Map<string, CustodyCoverage>()
  protected records: CustodyRecord[] = []
  protected effects: CustodyState = { records: [], receipts: [] }
  protected effectsUnreadable = false
  protected effectsWriteUnknown = false
  protected claimsHealthy = true
  protected admissionsClosed = false
  private sealed = false
  protected priorEpochSeal: CustodyEpochSeal | null = null

  constructor(
    private readonly journal: CustodyJournal,
    readonly authorityId: string,
    protected readonly now: () => number = Date.now,
    private readonly claimsJournal?: CustodyJournal,
    private readonly fenceWitness?: () => CustodyFenceOwner | null
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
        const claims = claimsJournal.read()
        this.priorEpochSeal = claims.epochSeal ?? null
        if (
          this.priorEpochSeal &&
          this.priorEpochSeal.recordsHash !== digest(JSON.stringify(claims.records))
        ) {
          this.claimsHealthy = false
        }
        for (const record of claims.records) {
          if (
            !this.records.some((entry) => entry.claim === record.claim) &&
            !this.effects.receipts.some(
              (receipt) => receipt.state !== 'refused' && receipt.claimHash === digest(record.claim)
            )
          ) {
            this.records.push(record)
          }
        }
      } catch {
        this.claimsHealthy = false
      }
    }
  }

  get complete(): boolean {
    return !this.effectsUnreadable && !this.effectsWriteUnknown && this.claimsHealthy
  }

  protected settled(record: CustodyRecord): boolean {
    if (record.outcome?.state === 'retired') {
      return true
    }
    if (this.effects.receipts.length === 0) {
      return false
    }
    const resourceHash = digest(custodyResourceKey(record.resource))
    const material = !record.fence && !record.outcome ? materialHash(record.resource) : null
    return this.effects.receipts.some(
      (receipt) =>
        receipt.state !== 'refused' &&
        (receipt.resourceHash === resourceHash || receipt.materialHash === material)
    )
  }

  protected liveOverlapping(resource: WorktreeCustodyResource): CustodyRecord[] {
    return this.records.filter(
      (entry) =>
        entry.resource.hostId === resource.hostId &&
        overlaps(entry.resource.path, resource.path) &&
        !this.settled(entry)
    )
  }

  protected record(resource: WorktreeCustodyResource): CustodyRecord {
    if (this.effectsUnreadable || this.effectsWriteUnknown) {
      throw new Error('custody_effects_unknown')
    }
    const record = this.records.find(
      (entry) => custodyResourceKey(entry.resource) === custodyResourceKey(resource)
    )
    if (!record) {
      throw new Error('custody_resource_unknown')
    }
    return record
  }

  /** The exclusive profile lock this incarnation holds, or null when unavailable. */
  protected currentFenceOwner(): CustodyFenceOwner | null {
    try {
      return this.fenceWitness?.() ?? null
    } catch {
      return null
    }
  }

  protected persistClaims(): boolean {
    if (this.sealed) {
      this.claimsHealthy = false
      return false
    }
    if (
      !this.claimsJournal ||
      (this.coverage.size === 0 &&
        this.effects.records.length === 0 &&
        this.effects.receipts.length === 0)
    ) {
      return false
    }
    try {
      this.claimsJournal.write({
        records: this.records.filter((record) => !record.fence && !record.outcome),
        receipts: []
      })
      return true
    } catch {
      this.claimsHealthy = false
      return false
    }
  }

  protected sealClaims(): boolean {
    if (this.sealed) {
      return this.complete
    }
    const owner = this.currentFenceOwner()
    if (
      !this.admissionsClosed ||
      !this.complete ||
      !owner ||
      (owner.startedAtMs === null && (!owner.linuxStartTicks || !owner.bootId)) ||
      !this.claimsJournal ||
      (this.coverage.size === 0 &&
        this.effects.records.length === 0 &&
        this.effects.receipts.length === 0)
    ) {
      return false
    }
    const records = this.records.filter((record) => !record.fence && !record.outcome)
    try {
      this.claimsJournal.write({
        records,
        receipts: [],
        epochSeal: {
          authorityId: this.authorityId,
          owner,
          recordsHash: digest(JSON.stringify(records)),
          recordedAt: this.now()
        }
      })
      this.sealed = true
      return true
    } catch {
      this.claimsHealthy = false
      return false
    }
  }

  protected commitReceipt(
    record: CustodyRecord,
    outcome: WorktreeCustodyOutcome,
    proof: string | null
  ): void {
    if (outcome.state !== 'retired' && outcome.state !== 'refused') {
      throw new Error('custody_receipt_not_terminal')
    }
    const state = outcome.state
    this.commitEffects(() => {
      record.outcome = state === 'retired' ? outcome : null
      if (state === 'refused') {
        record.fence = null
        delete record.fenceOwner
        delete record.recovery
      }
      this.effects.receipts.push({
        resourceHash: digest(custodyResourceKey(record.resource)),
        materialHash: materialHash(record.resource),
        claimHash: digest(record.claim),
        keyHash: digest(outcome.key),
        recordedAt: outcome.recordedAt,
        reason: outcome.reason,
        proof,
        state
      })
    })
    if (state === 'retired') {
      this.records = this.records.filter((entry) => entry !== record)
    } else {
      this.persistClaims()
    }
  }

  protected commitEffects(change: () => void): void {
    if (this.effectsUnreadable || this.effectsWriteUnknown) {
      throw new Error('custody_effects_unknown')
    }
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
          ) {
            this.records.push(record)
          }
        }
        this.effectsWriteUnknown = true
      }
      throw error
    }
  }
}
