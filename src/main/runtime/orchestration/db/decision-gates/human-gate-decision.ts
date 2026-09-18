import type Database from '../../../../sqlite/sync-database'
import { canonicalJson } from '../../../../../shared/canonical-json'
import {
  HumanGateDecisionSchema,
  HumanGatePrincipalSchema,
  HumanGateReferenceSchema,
  type HumanGateDecision,
  type HumanGatePrincipal,
  type HumanGateReceipt,
  type HumanGateRecord,
  type HumanGateRetirement
} from '../../../../../shared/human-gate-contract'
import { OrchestrationError } from '../../orchestration-error'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import { humanGateFingerprint } from './human-gate-fingerprint'
import { requireHumanGateRecord } from './human-gate-record'

// This callback belongs to the trusted host; it must authenticate and authorize the owner for this exact request.
export type HumanGateOwnerAuthority = (
  decision: Readonly<HumanGateDecision>,
  gate: Readonly<HumanGateRecord>
) => HumanGatePrincipal

export function recordHumanGateDecision(
  db: Database.Database,
  input: HumanGateDecision,
  authority: HumanGateOwnerAuthority
): HumanGateReceipt {
  const decision = HumanGateDecisionSchema.parse(input)
  return runLifecycleWriteTransaction(db, 'human_gate_decision', () => {
    const gate = requireHumanGateRecord(db, decision.gate_id)
    if (gate.request_fingerprint !== decision.request_fingerprint) {
      throw new OrchestrationError('human_gate_conflict', 'Human Gate request fingerprint mismatch')
    }
    // Copies keep an authority adapter from changing the already validated command or stored request.
    const principal = HumanGatePrincipalSchema.parse(
      authority(structuredClone(decision), structuredClone(gate))
    )
    if (gate.receipt) {
      if (
        gate.receipt.decision !== decision.decision ||
        canonicalJson(gate.receipt.principal) !== canonicalJson(principal)
      ) {
        throw new OrchestrationError(
          'human_gate_conflict',
          'Human Gate already has a different owner decision'
        )
      }
      return gate.receipt
    }
    const now = new Date().toISOString()
    if (
      gate.retirement ||
      (gate.request.expires_at !== null && now >= gate.request.expires_at) ||
      now < gate.request.requested_at
    ) {
      throw new OrchestrationError(
        'human_gate_inactive',
        'Human Gate is expired, superseded, or not yet requested'
      )
    }
    const payload = { schema_version: 1 as const, ...decision, principal, decided_at: now }
    const receipt = { ...payload, receipt_fingerprint: humanGateFingerprint('receipt', payload) }
    db.prepare(`INSERT INTO human_gate_receipts (gate_id, request_fingerprint, receipt_json)
      VALUES (?, ?, ?)`).run(gate.gate_id, gate.request_fingerprint, canonicalJson(receipt))
    return receipt
  })
}

export function expireHumanGate(
  db: Database.Database,
  input: { gate_id: string; request_fingerprint: string }
): HumanGateRetirement {
  const reference = HumanGateReferenceSchema.parse(input)
  return runLifecycleWriteTransaction(db, 'human_gate_expiry', () => {
    const gate = requireHumanGateRecord(db, reference.gate_id)
    if (gate.request_fingerprint !== reference.request_fingerprint) {
      throw new OrchestrationError('human_gate_conflict', 'Human Gate request fingerprint mismatch')
    }
    if (gate.retirement) {
      if (gate.retirement.state !== 'expired') {
        throw new OrchestrationError('human_gate_conflict', 'Human Gate already superseded')
      }
      return gate.retirement
    }
    const now = new Date().toISOString()
    if (gate.request.expires_at === null || now < gate.request.expires_at) {
      throw new OrchestrationError(
        'human_gate_not_expired',
        'Human Gate has not reached its explicit expiry'
      )
    }
    const retirement: HumanGateRetirement = {
      ...reference,
      state: 'expired',
      recorded_at: now,
      reason: 'request_expiry',
      successor: null
    }
    db.prepare(`INSERT INTO human_gate_retirements (gate_id, request_fingerprint, retirement_json)
      VALUES (?, ?, ?)`).run(gate.gate_id, gate.request_fingerprint, canonicalJson(retirement))
    return retirement
  })
}
