# Native Human Gate persistence (Core #81)

This is the upstream persistence prerequisite for
[OrbittechIA/oroboros-core#81](https://github.com/OrbittechIA/oroboros-core/issues/81).
Orca remains the authority for its existing Run, Task, Dispatch and decision-gate
IDs. Core owns mission registration and projects these records; this adds no
second mission or gate ledger.

## Native contract

`src/shared/human-gate-contract.ts` defines version 1. Trusted in-process callers
opt in through `OrchestrationDb.createGate({ taskId, question, humanGate })`.
`question` must equal the typed request's reason; legacy options are prohibited.
There is deliberately no Human Gate mutation RPC, CLI command or UI in this slice.
The existing `orchestration.gateCreate` RPC creates legacy gates only.

A request contains the exact native Run/Task IDs, canonical product, mission ID,
Core registration ID and contract ID. The producer must supply the registration
and contract from Core's authority, never a moving project pointer. Native storage
checks Run/Task membership and any supplied Dispatch ID. Legacy Runs cannot opt in.
Folder workspaces and SSH work use the same native identity; no worktree path or
local Git repository is required. Run-home storage owns this evidence, including
when a worker executes remotely. A disconnected source is unavailable.

Each immutable request also binds revision, source request time, optional expiry,
requester, source system/version, reason, risk, exact scope and subject, nonempty
`allows` and `does_not_allow`, and explicit evidence references (which may be an
empty array). A PR subject requires provider, repository, number and full 40- or
64-character lowercase head SHA. Providers are not restricted to GitHub. Other
operations have an explicit subject ID. The producer must use the PR subject for
PR decisions and must not substitute an operation label to omit its head.

The request fingerprint is SHA-256 over canonical JSON:
`{domain: "orca.human-gate.request.v1", value: {gate_id, request}}`.
Canonical JSON sorts object keys, preserves array order, omits undefined object
fields and does not normalize string contents. The native gate ID is included,
so two gates on one PR never share decision authority. A revision starts at 1;
a successor gets a new native gate ID and increments the predecessor's revision.

## Decisions and retirement

`recordHumanGateDecision(connection, command, ownerAuthority)` in
`db/decision-gates/human-gate-decision.ts` accepts only gate ID, exact request
fingerprint and typed `approved` / `rejected`. The trusted host supplies the
separate synchronous `HumanGateOwnerAuthority` callback. That adapter **must
verify authentication and owner authorization for the exact request and command**,
then return stable `{authority, subject_id}` identity. It must throw if it cannot
verify either. Never deserialize this authority from RPC parameters or return a
principal claimed by an agent, reviewer text or the decision payload. Storage is
an internal authority boundary, not an authentication provider; a future write
transport must implement that adapter before exposing decisions.

The receipt includes the authenticated principal, native decision timestamp and
SHA-256 fingerprint of the receipt payload under `orca.human-gate.receipt.v1`
(excluding `receipt_fingerprint` itself). The first write wins. An identical
fingerprint/decision/principal retry returns the exact stored receipt, including
after retirement. Any differing decision, principal or request fingerprint fails.
A failed or denied write leaves no receipt. A serialized SQLite write transaction
covers validation and insertion.

Approval is decision evidence. It does not execute anything, mark a mission done,
or release a Task. Typed gates retain their legacy `pending` envelope and blocked
Task; typed consumers use the typed record state. Existing legacy readers can list
that envelope, but must not treat it as typed coverage. Both current and downgraded
legacy free-text resolve/timeout SQL are refused by database triggers. Existing
legacy gates remain writable. Task execution policy is outside this persistence
contract and must independently require current request/head/scope evidence.

Supersession is explicit: create a successor with `supersedes` containing the exact
predecessor gate ID and fingerprint. Its full identity must match, its revision
must increment by one, and the predecessor cannot already be retired. Request
insertion, predecessor retirement and native gate lifecycle changes are atomic.
Changed head/scope requires a new request; no receipt is copied. Historical
approved/rejected receipts remain visible beneath the superseded state.

`expireHumanGate(connection, reference)` explicitly records retirement once the
request's expiry is reached. Expiry is idempotent and retains any receipt. A read
never expires a gate: until that explicit write, its persisted state can remain
pending after `expires_at`. Consumers must check expiry before presenting an
actionable request; the decision writer always rejects late or future-dated
requests. Retirement takes precedence over receipt state in the projection.

## Read-only Core handoff

`readHumanGates(connection, exactIdentity, limit?)` and
`readHumanGatesFile(path, exactIdentity, limit?)` in
`db/decision-gates/human-gate-projection.ts` return:

```ts
{
  schema_version: 1,
  identity: { run_id, task_id, canonical_product, mission_id, registration_id, contract_id },
  coverage: 'complete' | 'partial' | 'unavailable',
  reasons: string[],
  gates: [{ gate_id, request_fingerprint, request, state, receipt, retirement }]
}
```

The file reader opens an existing SQLite file read-only. It never constructs
`OrchestrationDb`, creates a missing file, migrates, backfills, expires, acknowledges
or repairs anything. The connection reader executes SELECTs only. Gate rows,
receipts, retirements and native Task coverage come from one SQLite statement.
Results are ordered by gate ID, bounded to 500 records by default (maximum 1000),
and contain original authority timestamps rather than ingestion timestamps.

- `complete`: all matching typed records were read. `gates: []` is confirmed empty
  for this exact filter in the native source. Core must separately verify that the
  supplied mission registration/contract is authoritative; native storage cannot
  confirm Core registrations it does not own.
- `partial`: `legacy_gates`, `truncated` or `invalid_record`. Legacy gates on the
  exact native Task make coverage partial because their mission identity is unknown.
  Invalid records are omitted, never reconstructed from prose or PR heuristics.
- `unavailable`: `unsupported_schema`, `identity_not_found` or `source_unavailable`.
  Missing/old databases and lost source access never mean confirmed empty.

Core should propagate this coverage and impose its own authority freshness rules.
It must not turn a complete storage read into a claim that a PR head is still
current. Consumers on a different host must use a future negotiated read transport
or execute this reader on the authority host; this change introduces no wire
capability or remote activation.

## Migration, downgrade and recovery

Schema v42 adds three tables (`human_gate_requests`, `human_gate_receipts`,
`human_gate_retirements`), one lookup index, and integrity/immutability triggers.
Existing tables, columns, rows and RPC response shapes are unchanged. Migration is
transactional and only advances `user_version` after success. Reopening is safe;
an interrupted migration rolls back and may be retried.

Requests, receipts and retirements cannot be updated, replaced or deleted through
ordinary SQL. Native identity and legacy gate guards remain in the database when
an older binary opens it. Downgrade is a **binary rollback retaining v42 schema and
triggers**, not a down migration: older clients continue working with legacy gates
and fail closed on typed mutations. Reset-all/reset-tasks fail atomically when they
would erase typed history. There is no destructive cleanup or down-migration API.

Validation uses only in-memory or temporary databases: migration compatibility,
old-client SQL, typed requests and receipts, head/scope changes, identity isolation,
expiry/supersession, SELECT-only and read-only-file proofs, injected transaction
failures, reopening and receipt retry recovery. No live migration or activation is
part of this prerequisite.
