import { z } from 'zod'
import type Database from '../../../../sqlite/sync-database'
import {
  HumanGateRequestSchema,
  HumanGateReceiptSchema,
  HumanGateRetirementSchema,
  type HumanGateRecord
} from '../../../../../shared/human-gate-contract'
import { humanGateFingerprint } from './human-gate-fingerprint'
import { OrchestrationError } from '../../orchestration-error'

export const HumanGateStorageRow = z.object({
  gate_id: z.string(),
  request_json: z.string(),
  request_fingerprint: z.string(),
  receipt_json: z.string().nullable(),
  retirement_json: z.string().nullable()
})
export const HUMAN_GATE_RECORD_COLUMNS = `r.gate_id, r.request_json, r.request_fingerprint,
  d.receipt_json, e.retirement_json`
export const HUMAN_GATE_RECORD_JOINS = `
  LEFT JOIN human_gate_receipts d ON d.gate_id = r.gate_id
  LEFT JOIN human_gate_retirements e ON e.gate_id = r.gate_id`

export function decodeHumanGateRecord(value: unknown): HumanGateRecord {
  const row = HumanGateStorageRow.parse(value)
  const request = HumanGateRequestSchema.parse(JSON.parse(row.request_json))
  const receipt =
    row.receipt_json === null ? null : HumanGateReceiptSchema.parse(JSON.parse(row.receipt_json))
  const retirement =
    row.retirement_json === null
      ? null
      : HumanGateRetirementSchema.parse(JSON.parse(row.retirement_json))
  if (
    humanGateFingerprint('request', { gate_id: row.gate_id, request }) !== row.request_fingerprint
  ) {
    throw new Error('Human Gate request fingerprint mismatch')
  }
  for (const bound of [receipt, retirement]) {
    if (
      bound &&
      (bound.gate_id !== row.gate_id || bound.request_fingerprint !== row.request_fingerprint)
    ) {
      throw new Error('Human Gate history binding mismatch')
    }
  }
  if (receipt) {
    const { receipt_fingerprint, ...payload } = receipt
    if (humanGateFingerprint('receipt', payload) !== receipt_fingerprint) {
      throw new Error('Human Gate receipt fingerprint mismatch')
    }
  }
  return {
    gate_id: row.gate_id,
    request_fingerprint: row.request_fingerprint,
    request,
    state: retirement?.state ?? receipt?.decision ?? 'pending',
    receipt,
    retirement
  }
}

export function requireHumanGateRecord(db: Database.Database, gateId: string): HumanGateRecord {
  const row = db
    .prepare(`SELECT ${HUMAN_GATE_RECORD_COLUMNS}
    FROM human_gate_requests r ${HUMAN_GATE_RECORD_JOINS} WHERE r.gate_id = ?`)
    .get(gateId)
  if (!row) {
    throw new OrchestrationError('human_gate_not_found', 'Typed Human Gate not found')
  }
  return decodeHumanGateRecord(row)
}
