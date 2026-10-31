import {
  custodyResourceKey,
  type WorktreeCustodyOutcome,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'
import {
  digest,
  materialHash,
  type CustodyJournal,
  type CustodyRetirementConfirmation
} from './worktree-custody-records'

const INTENT_CLAIM = 'native-fixed-retire'

/** One entry per exact resource and key, so the same key on another resource never collides. */
function binding(resource: WorktreeCustodyResource, key: string): string {
  return digest(JSON.stringify([custodyResourceKey(resource), key]))
}

/**
 * The fixed effect's own durable result: intent before Git, removal after Git returns. Only a
 * committed removal for the exact resource and key is evidence; intent alone stays unknown.
 * The removal receipt replaces its intent so live records stay within the journal bound.
 */
export class NativeRetirementResults {
  constructor(
    private readonly journal: CustodyJournal | null,
    private readonly owner: string
  ) {}

  /** Throws before any effect when the intent cannot be made durable. */
  recordIntent(resource: WorktreeCustodyResource, key: string): void {
    const journal = this.require()
    const state = journal.read()
    if (this.intent(state, resource, key) || this.removed(state, resource, key)) {
      throw new Error('custody_native_intent_exists')
    }
    // Custody admits another key for a generation only after a pre-effect refusal of the last one.
    const resourceKey = custodyResourceKey(resource)
    state.records = state.records.filter(
      (record) => custodyResourceKey(record.resource) !== resourceKey
    )
    state.records.push({
      resource: structuredClone(resource),
      claim: `${INTENT_CLAIM}:${binding(resource, key)}`,
      releaseProof: null,
      revoked: false,
      fence: null,
      // The journal requires unique outcome keys, so store the resource-bound key digest.
      outcome: {
        resource: structuredClone(resource),
        key: binding(resource, key),
        state: 'dispatched',
        recordedAt: Date.now(),
        reason: null
      }
    })
    journal.write(state)
  }

  recordRemoved(resource: WorktreeCustodyResource, key: string): void {
    const journal = this.require()
    const state = journal.read()
    if (this.removed(state, resource, key)) {
      return
    }
    if (!this.intent(state, resource, key)) {
      throw new Error('custody_native_intent_missing')
    }
    const resourceKey = custodyResourceKey(resource)
    state.records = state.records.filter(
      (record) =>
        record.claim !== `${INTENT_CLAIM}:${binding(resource, key)}` ||
        custodyResourceKey(record.resource) !== resourceKey
    )
    state.receipts.push({
      resourceHash: digest(custodyResourceKey(resource)),
      materialHash: materialHash(resource),
      claimHash: this.claimHash(),
      keyHash: binding(resource, key),
      recordedAt: Date.now(),
      reason: null,
      proof: null,
      state: 'retired'
    })
    journal.write(state)
  }

  /** Read-only: confirmation only from this owner's committed removal for the exact resource/key. */
  confirmed(outcome: WorktreeCustodyOutcome): CustodyRetirementConfirmation | null {
    if (!this.journal || (outcome.state !== 'dispatched' && outcome.state !== 'unknown')) {
      return null
    }
    try {
      const state = this.journal.read()
      if (!this.removed(state, outcome.resource, outcome.key)) {
        return null
      }
      return {
        resource: outcome.resource,
        key: outcome.key,
        confirmed: true,
        proof: `native-result:${digest(custodyResourceKey(outcome.resource)).slice(0, 16)}:${digest(outcome.key).slice(0, 16)}`
      }
    } catch {
      return null
    }
  }

  private require(): CustodyJournal {
    if (!this.journal) {
      throw new Error('custody_native_result_store_unavailable')
    }
    return this.journal
  }

  private claimHash(): string {
    return digest(JSON.stringify([INTENT_CLAIM, this.owner]))
  }

  private intent(
    state: ReturnType<CustodyJournal['read']>,
    resource: WorktreeCustodyResource,
    key: string
  ): boolean {
    const resourceKey = custodyResourceKey(resource)
    return state.records.some(
      (record) =>
        record.claim === `${INTENT_CLAIM}:${binding(resource, key)}` &&
        custodyResourceKey(record.resource) === resourceKey &&
        record.outcome?.key === binding(resource, key)
    )
  }

  private removed(
    state: ReturnType<CustodyJournal['read']>,
    resource: WorktreeCustodyResource,
    key: string
  ): boolean {
    const resourceHash = digest(custodyResourceKey(resource))
    const keyHash = binding(resource, key)
    const claimHash = this.claimHash()
    return state.receipts.some(
      (receipt) =>
        receipt.state === 'retired' &&
        receipt.resourceHash === resourceHash &&
        receipt.keyHash === keyHash &&
        receipt.claimHash === claimHash
    )
  }
}
