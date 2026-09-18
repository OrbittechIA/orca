import type { OrchestrationDb } from '../orchestration-db'

export const HUMAN_GATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS human_gate_requests (
    gate_id TEXT PRIMARY KEY REFERENCES decision_gates(id),
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint) = 64),
    CHECK(json_extract(request_json, '$.schema_version') IS 1),
    CHECK(json_extract(request_json, '$.identity.run_id') IS run_id),
    CHECK(json_extract(request_json, '$.identity.task_id') IS task_id),
    CHECK(json_extract(request_json, '$.identity') IS identity_json)
  );
  CREATE INDEX IF NOT EXISTS idx_human_gate_identity ON human_gate_requests(identity_json, gate_id);
  CREATE TABLE IF NOT EXISTS human_gate_receipts (
    gate_id TEXT PRIMARY KEY REFERENCES human_gate_requests(gate_id),
    request_fingerprint TEXT NOT NULL REFERENCES human_gate_requests(request_fingerprint),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    CHECK(json_extract(receipt_json, '$.gate_id') IS gate_id),
    CHECK(json_extract(receipt_json, '$.request_fingerprint') IS request_fingerprint),
    CHECK(COALESCE(json_extract(receipt_json, '$.decision'), '') IN ('approved', 'rejected'))
  );
  CREATE TABLE IF NOT EXISTS human_gate_retirements (
    gate_id TEXT PRIMARY KEY REFERENCES human_gate_requests(gate_id),
    request_fingerprint TEXT NOT NULL REFERENCES human_gate_requests(request_fingerprint),
    retirement_json TEXT NOT NULL CHECK(json_valid(retirement_json)),
    CHECK(json_extract(retirement_json, '$.gate_id') IS gate_id),
    CHECK(json_extract(retirement_json, '$.request_fingerprint') IS request_fingerprint),
    CHECK(COALESCE(json_extract(retirement_json, '$.state'), '') IN ('superseded', 'expired'))
  );
  CREATE TRIGGER IF NOT EXISTS human_gate_request_binding BEFORE INSERT ON human_gate_requests
  WHEN NOT EXISTS (SELECT 1 FROM decision_gates g JOIN tasks t ON t.id = g.task_id
    JOIN runs r ON r.id = g.run_id
    WHERE g.id = NEW.gate_id AND g.run_id = NEW.run_id AND g.task_id = NEW.task_id
      AND t.run_id = NEW.run_id AND r.legacy = 0 AND g.status = 'pending'
      AND g.question = json_extract(NEW.request_json, '$.reason') AND g.options = '[]')
  BEGIN SELECT RAISE(ABORT, 'Human Gate identity mismatch'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_receipt_binding BEFORE INSERT ON human_gate_receipts
  WHEN NOT EXISTS (SELECT 1 FROM human_gate_requests r
    WHERE r.gate_id = NEW.gate_id AND r.request_fingerprint = NEW.request_fingerprint)
    OR EXISTS (SELECT 1 FROM human_gate_retirements WHERE gate_id = NEW.gate_id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate receipt conflict'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_retirement_binding BEFORE INSERT ON human_gate_retirements
  WHEN NOT EXISTS (SELECT 1 FROM human_gate_requests r
    WHERE r.gate_id = NEW.gate_id AND r.request_fingerprint = NEW.request_fingerprint)
  BEGIN SELECT RAISE(ABORT, 'Human Gate retirement conflict'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_legacy_replace BEFORE INSERT ON decision_gates
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE gate_id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_task_replace BEFORE INSERT ON tasks
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE task_id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_run_replace BEFORE INSERT ON runs
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE run_id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_run_identity BEFORE UPDATE OF id, legacy ON runs
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE run_id = OLD.id)
    AND (NEW.id != OLD.id OR NEW.legacy != OLD.legacy)
  BEGIN SELECT RAISE(ABORT, 'Human Gate identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_legacy_update BEFORE UPDATE ON decision_gates
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE gate_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Typed Human Gate requires native authority'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_legacy_delete BEFORE DELETE ON decision_gates
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE gate_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_task_identity BEFORE UPDATE OF id, run_id ON tasks
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE task_id = OLD.id)
    AND (NEW.id != OLD.id OR NEW.run_id != OLD.run_id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_task_delete BEFORE DELETE ON tasks
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE task_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS human_gate_run_delete BEFORE DELETE ON runs
  WHEN EXISTS (SELECT 1 FROM human_gate_requests WHERE run_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
  ${['human_gate_requests', 'human_gate_receipts', 'human_gate_retirements']
    .map(
      (table) => `
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE gate_id = NEW.gate_id)
    BEGIN SELECT RAISE(ABORT, 'Human Gate history is immutable'); END;
  `
    )
    .join('\n')}
`

export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current < 42) {
    this.db.exec(HUMAN_GATE_SCHEMA_SQL)
  }
}
