import { z } from 'zod'
import Database from '../../../../sqlite/sync-database'
import { canonicalJson } from '../../../../../shared/canonical-json'
import {
  HumanGateIdentitySchema,
  type HumanGateIdentity,
  type HumanGateProjection
} from '../../../../../shared/human-gate-contract'
import {
  decodeHumanGateRecord,
  HUMAN_GATE_RECORD_COLUMNS,
  HUMAN_GATE_RECORD_JOINS
} from './human-gate-record'

function unavailable(identity: HumanGateIdentity, reason: string): HumanGateProjection {
  return { schema_version: 1, identity, coverage: 'unavailable', reasons: [reason], gates: [] }
}

// SELECT only: callers may pass an already open connection or a genuinely read-only file handle.
export function readHumanGates(
  db: Database.Database,
  input: HumanGateIdentity,
  limit = 500
): HumanGateProjection {
  const identity = HumanGateIdentitySchema.parse(input)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Human Gate limit must be 1..1000')
  }
  try {
    const supported = db
      .prepare(`SELECT count(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('human_gate_requests', 'human_gate_receipts', 'human_gate_retirements')`)
      .get()
    if (supported?.count !== 3) {
      return unavailable(identity, 'unsupported_schema')
    }
    const rows = db
      .prepare(`SELECT ${HUMAN_GATE_RECORD_COLUMNS},
      EXISTS(SELECT 1 FROM tasks WHERE id = ? AND run_id = ?) AS task_exists,
      EXISTS(SELECT 1 FROM decision_gates g WHERE g.run_id = ? AND g.task_id = ?
        AND NOT EXISTS(SELECT 1 FROM human_gate_requests h WHERE h.gate_id = g.id)) AS legacy_exists
      FROM (SELECT 1) scope
      LEFT JOIN human_gate_requests r ON r.identity_json = ?
      ${HUMAN_GATE_RECORD_JOINS}
      ORDER BY r.gate_id LIMIT ?`)
      .all(
        identity.task_id,
        identity.run_id,
        identity.run_id,
        identity.task_id,
        canonicalJson(identity),
        limit + 1
      )
    const meta = z.object({ task_exists: z.number(), legacy_exists: z.number() }).parse(rows[0])
    if (!meta.task_exists) {
      return unavailable(identity, 'identity_not_found')
    }
    const result: HumanGateProjection = {
      schema_version: 1,
      identity,
      coverage: 'complete',
      reasons: [],
      gates: []
    }
    if (meta.legacy_exists) {
      result.reasons.push('legacy_gates')
    }
    if (rows.length > limit) {
      result.reasons.push('truncated')
    }
    for (const row of rows.slice(0, limit)) {
      if (row.gate_id === null) {
        continue
      }
      try {
        const gate = decodeHumanGateRecord(row)
        if (canonicalJson(gate.request.identity) !== canonicalJson(identity)) {
          throw new Error('Identity mismatch')
        }
        result.gates.push(gate)
      } catch {
        if (!result.reasons.includes('invalid_record')) {
          result.reasons.push('invalid_record')
        }
      }
    }
    if (result.reasons.length) {
      result.coverage = 'partial'
    }
    return result
  } catch {
    return unavailable(identity, 'source_unavailable')
  }
}

export function readHumanGatesFile(
  path: string,
  input: HumanGateIdentity,
  limit = 500
): HumanGateProjection {
  const identity = HumanGateIdentitySchema.parse(input)
  let db: Database.Database | undefined
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    return readHumanGates(db, identity, limit)
  } catch {
    return unavailable(identity, 'source_unavailable')
  } finally {
    db?.close()
  }
}
