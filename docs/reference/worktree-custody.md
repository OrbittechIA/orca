# Native worktree custody v1

This is a source foundation for a trusted material-lifecycle adapter. It does not
certify existing worktrees for cleanup. Startup installs the native orchestration
provider for observation, but no native authority attests external consumers, so
coverage is not installed and the runtime does not advertise
`worktree.custody.no-stop.v1`.
The installed 1.4.224 runtime does not implement this staged source.

The separate `worktree.custody.v1` RPC never calls interactive `worktree.rm`,
terminal close, session stop, archive hooks, branch deletion, or history purge.
Its fixed native effect uses unforced Git worktree removal with
`deleteBranch=false`, after fresh exact identity, consumer and preservation
proof under an exclusive producer grant. Its local scan refuses symlinks,
cross-device material, foreign ownership, hardlinks, special files, more than
2,048 files, 4,096 entries, 1 GiB allocated, depth 128 or ten seconds. The Git
effect receives the remaining ten-second budget as an abort deadline. An
uncertain effect stays unknown; timeout is never interpreted as process exit.

Core retains its existing seven-day merge/completion retention, 72-hour last-use
policy, preservation checks and aggregate/effect budgets. Native card status and
lastActivityAt are not authoritative completion or last use. This API supplies
no merged/completed timestamps, last-use timestamp or code/material preservation
fact by inference. A trusted producer must supply missing ownership proofs and
Core must retain the independent provenance for those policy facts.

## Wire and CLI

All requests use the strict discriminated schema in
`src/shared/worktree/custody-schema.ts` and `schemaVersion: 1`. Unknown fields,
missing bindings and alternate operation shapes are rejected. There is no RPC
that installs providers, registers a released disposition or accepts a caller's
free-form observation as proof.

| operation | Required fields beyond schemaVersion/operation | Response fields beyond schemaVersion               |
| --------- | ---------------------------------------------- | -------------------------------------------------- |
| list      | none                                           | supported, authorityId, resources, complete, scope |
| observe   | resource                                       | observation                                        |
| capture   | resource                                       | fence                                              |
| check     | fence                                          | valid=true, or refusal                             |
| cancel    | fence                                          | cancelled=true, or refusal                         |
| retire    | fence, key                                     | outcome                                            |
| reconcile | resource, key                                  | outcome, or null when never dispatched             |

`resource` is exactly `{worktreeId,path,instanceId,hostId,owner,product,task,generation}`.
Every field is a nonempty bounded string. Equality includes all eight fields;
branch name and terminal absence cannot identify a resource. The producer
generates `generation` once when enrolling its dispatch claim.

`fence` is exactly `{resource,token,authorityId,capturedAt,expiresAt}`. Token and
authorityId are UUIDs. All times are Unix epoch **milliseconds**. The authorityId
is a custody incarnation, distinct from the real runtime's `status.runtimeId` and
RPC `_meta.runtimeId`. Capture lasts at most 30 seconds. The host uses its stored
deadline; client edits cannot extend it. Check is a synchronous local grant
validation, not a process scan or a new CLI inventory per file.

`observation` is `{resource,claim,observedAt,disposition,releaseProof,domains}`.
`claim` is the authority's stored `dispatch:<dispatchId>` for orchestration-owned
resources, otherwise null. A coverage provider cannot supply or replace it. Earlier
hosts omit this additive field: consumers must keep an unbound completion unknown,
never infer a Dispatch from a task, path or random generation. Core requires its
canonical completion's succeeded Run and fleet binding to match the native task,
worktree and enrolling Dispatch before binding instance/product/generation.
Disposition is held/released/unknown. releaseProof is a native producer receipt
identifier or null. Each domain entry is
`{domain,observedAt,complete,active,held,proof}`; active and held can be null and
proof can be null. Capture and retirement require exactly one fresh entry per
domain, complete=true, active=false, held=false and a nonempty owning proof.
Domains are terminal, structured-session, dispatch, recovery, workspace,
registered-consumer, external-consumer and preservation. Missing, future, stale,
duplicate, active, held and unknown entries refuse. A released producer claim
alone is insufficient.

`outcome` is exactly `{resource,key,state,recordedAt,reason}`. State is
dispatched/retired/unknown/refused; current execution records dispatched before
the native effect, then retired or unknown. Keys match
`^[a-zA-Z0-9_-]{16,128}$`. A key is bound to the whole resource and one release
generation. It cannot authorize another generation or another resource.

```text
orca worktree custody --operation list --json
orca worktree custody --operation observe --resource '<native resource JSON>' --json
orca worktree custody --operation capture --resource '<native resource JSON>' --json
orca worktree custody --operation check --fence '<native fence JSON>' --json
orca worktree custody --operation retire --fence '<native fence JSON>' --key <immutable-key> --json
orca worktree custody --operation reconcile --resource '<native resource JSON>' --key <same-key> --json
orca worktree custody --operation cancel --fence '<undispatched fence JSON>' --json
```

The list is **native-enrolled-only**, never an inventory of all native or external
worktrees. It exposes one current claim generation per exact host/path and omits confirmed
retired tombstones. Observation aggregates every unsettled overlapping generation:
any held or revoked generation prevents a released disposition. Capture and retire
also refuse every competing fence/outcome or active admission on overlapping paths.
A completed material instance cannot dispatch again through a sibling generation;
fresh path reuse requires a different native instance. Earlier receipts remain available by exact
resource/key for reconciliation. A trusted adapter must separately verify the
complete native inventory, reject overlaps and identity substitutions, and
retain unknown resources. Empty enrollment conveys no unused-resource proof.

Old or mixed clients/hosts refuse unknown methods or missing capability. There
is no fallback to rm, force, terminal close or a different execution host. Folder,
legacy, remote and Windows resources are unsupported by this local producer;
Windows stays unsupported until equivalent durable directory commits exist.

## Producers and consumers

`placeWorkerAgent` enrolls exact local Git-worktree identity and its task/dispatch
binding. Native `settleWorkerTerminalRelease` publishes release only after its
durable released ownership row commits; `settleDeadWorkerTerminalRelease` does
the same after its transaction commits and its incarnation-fenced settlement.
The custody command never triggers these release operations. A worker report,
completed card, missing terminal or lease expiry does not publish release.
Release publication requires the Dispatch's `worker_dispatches` row in a releasable
state (`succeeded` or `failed`) on the claimed worktree, its `dispatch_contexts` row
settled (`completed`, `failed` or `circuit_broken`) for the claimed native task, and every
current, original or prior-owned resource to be durably released. It uses one stable
Dispatch proof, rather than a per-terminal proof. A microtask rechecks actual committed
rows after the outer synchronous transaction; a rolled-back or still-open transaction
cannot publish. Native observation retries the same durable rows after a missed
callback or restart. Publication failure is pending proof and does not undo native
worker settlement. A later producer/consumer start revokes released eligibility;
a failed optional metadata write disables capture, without blocking the Start.
Pure file-target lookups only check fences and perform no journal write.

Actual admission guards cover the shared renderer/runtime PTY spawn operation
(including restore/recovery/reattach), high-level runtime terminal/agent creation,
structured attach/resume/ensure acquisition, send/queue/session mutations before
journal changes, explicit workspace resume, workspace wake/reopen, activation,
interactive removal, metadata/parent-lineage writes,
automatic coordinator dispatch, direct terminal/chat dispatch, local worker-start
reservation/placement, and runtime known-file/worktree-file target resolution.
Every async guarded operation holds its admission until settlement; background
legacy removal keeps it until the native pending-removal promise settles. Capture
closes the exact resource and overlapping paths before acquiring external grants.
Interactive rm otherwise retains its existing semantics.

Native observation reads exact worktree identity, current desktop selection from
the local host partition, child/pinned/status holds, fresh bounded PTY/surface
inventory, opened structured-session leases, sleep reservations, open-journal
owed work/approval holds, and bounded dispatch/worker-release ownership. It reports metadata and proof identifiers,
never chat or process contents. Unopened stores, unbound dispatches, truncated
inventories, mobile/remote/current ownership not positively covered, QA/rollback
reservations, external process access, LSP/file/browser clients and preservation
remain incomplete. File target guards do not certify that existing watches or
external clients have stopped using a checkout.

Trusted native host code may install an owning producer with
`installNativeWorktreeCustodyRetirement(runtime, provider)`. Its observe/acquire/
check/release/reconcile/recoverFence/recoverRelease ports must cover **all** remaining producer and consumer
claims, including future ingress, and positively attest preservation. A process
scan alone cannot do so. Provider proof cannot erase a native positive hold.
The fixed native retirement effect is supplied by Orca, not by RPC data. Merely
adding an interface or setting a feature flag cannot enable the capability.

`installNativeWorktreeCustodyProvider(runtime)` is that host composition. Desktop
and headless startup call it once after constructing the runtime; the custody RPC
calls the same idempotent installer for hosts that skip that composition. Caller
data never reaches it. The `orchestration` provider (`worktree-custody-native-provider.ts`)
binds only existing owners:

| domain              | owning source                                                                                                                                                                      | complete when                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| structured-session  | opened single-writer agent-session record store and open-journal work                                                                                                              | store opened                         |
| recovery            | sleep records, pending/failed removals, recoverable `worker_dispatches`, session spawn reservations                                                                                | store and workspace session readable |
| workspace           | host workspace session: selection, open editor/browser/unified tabs; status, pin, children, removal                                                                                | workspace session readable           |
| registered-consumer | desktop watched/suspended/in-flight watcher roots and runtime file-watch leases                                                                                                    | always (in-process registries)       |
| preservation        | Git: no tracked, untracked or ignored entry; only plain index entries; no gitlink; HEAD on a shared branch the fixed effect retains; no per-worktree refs or in-progress operation | Git answered                         |
| external-consumer   | none on this host                                                                                                                                                                  | never                                |

Terminal and dispatch keep the native observation above. Native product is the
physical `projectId`; a native Task has no product, so Core must bind its own
product to that projectId explicitly. Any positive hold skips the Git read.

Its grant takes the existing watcher-removal gate for the exact path, which refuses
fresh watcher and PTY installs on overlapping roots until release, waits at most
five seconds for in-flight installs, and refuses if any registered consumer exists.
`check()` only rereads the registries. Reconcile, prior-incarnation fence recovery
and prior-epoch release recovery return unconfirmed: no owning durable result store,
retained grant-settlement proof or durable consumer-admission history exists, so
those stay unknown and protected.

Coverage, and therefore the capability, is installed only when the provider is
`ready`, which requires a host-only external-consumer authority. None exists, so
this build installs observation only. A process scan or file-target guard cannot
be that authority.

## Crash, reconciliation and rollback

Optional claims metadata is separate from effect authority. The private
`worktree-custody-v1/custody.json` claims file is never written before coverage
opt-in or existing effect state. Corrupt, read-only, unsafe, locked or full claims
metadata makes inventory incomplete and capture unsupported; it does not block
ordinary Starts or unrelated work. Read-only admission does not revoke release or
fsync. The process retains one authority per user-data directory across runtime ID
changes, including live admissions, grants and coverage.

The separate `worktree-custody-effects-v1/custody.json` is first created by capture.
It records exact-resource fences and dispatched outcomes with exclusive writer
admission, revision checks, atomic replacement, file fsync and directory fsync.
Unreadable effect inventory refuses **every local path**, including unrelated
Starts, because its affected paths cannot be safely enumerated. This global
`custody_effects_unknown` state differs from an exact known pending fence and is
not an optional-claims failure. No effects inventory is created in the default
no-provider build. An effect
write failure retains the affected pending paths in memory and refuses further
custody mutation; unrelated known paths remain available. Restart reads the durable
fence/outcome. A stale writer lock is never stolen using age, PID absence or missing
consumers. Capture is durable before acquiring grants; dispatch is durable before
any effect. No absent path, consumer, process or result is recovery proof.

The private v3 storage reads v1/v2 record envelopes and retains terminal operations as
compact tombstones bound by SHA-256 to the full resource, material instance, claim
and key. Exact caller-supplied identity/key can reconstruct a retired receipt; a
changed key or binding cannot dispatch. Claims without effects may be evicted only
when unrevoked and confirmed released in this custody incarnation, with every
overlapping generation also confirmed released. At the 2,048-entry enrollment
bound, revoked, held and prior-incarnation unknown generations remain retained;
if no fully released path is disposable, new enrollment refuses without blocking
ordinary Starts.
Effect and refusal tombstones are never evicted or expired. The effects file retains at most
2,048 live records and a 16,384-receipt count ceiling, with an independent
4 MiB serialized-byte cap that usually wins first. A minimal receipt is roughly
350 bytes; about 12k or fewer can fit before accounting for live records, reasons
and bounded proof strings. This is a ceiling, not promised usable capacity. Capacity refuses before any
write, does not poison admissions, and preserves all earlier idempotency. Reaching
the terminal receipt budget requires a separately reviewed archival authority;
restarting or deleting the journal is never compaction.

Current-incarnation undispatched fences can be cancelled after their durable clear.
For a prior incarnation, host-only `recoverFence` must positively attest that the
owning recovery authority settled all grants for that exact fence, including
resource, token, authority and timestamps. A proofless, substituted or unavailable
result keeps the fence. Recovery proof is persisted before admission reopens;
there is no automatic expiry release or caller assertion on RPC.

Reconcile dispatches no effect. A trusted owning result query must bind the same
resource/key and a nonempty proof identifier. Confirmed settlement is durably
recorded as a compact receipt before returning retired or admitting path reuse,
so restart does not require an in-memory confirmation again. Failure to persist
confirmation retains the original pending outcome. Stored retired/refused receipts replay
without provider access. If a terminal receipt cannot be committed after an actual
effect, retire/reconcile returns structured `unknown` with
`native_outcome_commit_pending`; the durable dispatched/pending record stays
fenced and the effect is never retried. Reconciliation proofs exceeding 8 KiB
remain unknown instead of filling the journal. The fixed native provider cannot manufacture confirmation
from an absent directory.

Only the fixed native retirement port can certify a no-effect refusal. Its
preflight catch surrounds identity, material budget, symlink, cleanliness and
fence checks **before entering removeWorktree**. The exception and proof are
private to that module and bound to its exact registered retirement callback,
resource and error object. There is no exported refusal constructor or issuer.
The authority captures the callback once before durable dispatch, invokes that exact reference with its receiver and validates against the same reference; replacing a coverage property during the call cannot change the proof authority.
Generic coverage cannot manufacture the proof or reuse another fixed port's
error after an effect; JSON, error names, messages and matching resource fields
are not authority. Every exception after removal entry remains unknown.

Provider grant `check()` must be a synchronous, side-effect-free validity probe:
it must not mutate checkout material, start/stop consumers or dispatch work.
It runs inside fixed preflight and its failure may produce a refusal. The
no-effect proof certifies that Orca's fixed removal was never entered; it does
not certify arbitrary provider effects or make a side-effecting check valid.
Complete trusted provider qualification must verify this contract.

A durable `refused` receipt spends that key and clears the fence, so ordinary
Start works across restart. A different key requires a fresh capture. If the
owned terminal grant's synchronous release fails, the authority retains that
exact resource/key grant. Subsequent native inventory, resource observation or
capture makes one bounded retry pass over the matching terminal grants, even
when Core treats REFUSED as terminal and never replays it. Same-key
retire/reconcile also retries. No timer or destructive resend is added; retries
cannot change the canonical outcome or release a newer nonterminal grant.
A failed refusal receipt write retains the original pending protection and
returns unknown.

Startup interrupted-removal jobs also take a `reopen=false` custody admission
before metadata, teardown or Git entry and retain it through the resumed job's
actual background settlement, including asynchronous failure cleanup. Native pending-removal observation is an
additional positive hold, not the only exclusion protecting startup resumption.
A typed custody refusal is retained as a failed removal without entering branch, remote or filesystem failure cleanup. When startup admission refuses, the custody fence and failed-removal record
remain. The job does not reach the watcher-gate handoff; the background executor
owns release of its startup loading fence in its `finally`. That loading fence
is distinct from custody's durable exclusion. Preserve both removal/custody
records and obtain the owning outcome/recovery proof; then retry the retained
failed removal through the normal admitted removal request. Do not erase state,
force-release custody or treat restart/absence as permission to resume deletion.
This guard does not certify or activate any complete provider.

Release eligibility carries `releaseEpoch`, the stable custody authority UUID,
which survives runtime-ID changes but changes across process restarts. Historical
release metadata is `unknown` in a new incarnation even if its old file looks
healthy and a failed write removed its lock. Replaying the same native DB release
proof never renews its epoch. This covers failed revocation writes from stale
locks, ENOSPC and EROFS without making ordinary Start depend on those writes.

Host-only `recoverRelease` may renew an old release only with a positive owning
**durable producer and consumer history** proof covering intervening admission and
reopen, bound to all eight resource fields, the claim, original release proof,
previous epoch and current authority. An old released worker row, no live process,
no lock, fresh idle scan or caller assertion is insufficient. Missing, false,
substituted, oversized or unavailable proof stays unknown. Confirmation and its
proof are persisted with the new epoch before capture becomes eligible; a failed
write disables capture. The next incarnation requires owning revalidation again.
Owning recovery is invoked automatically during observation/capture; it adds no
routine owner-approval step. Fresh current-incarnation native releases remain
eligible, so unavailable recovery does not disable all future automation. There is no public recover/install/release
assertion RPC and no complete recovery provider is installed here.

For a global effects-unknown diagnosis, preserve every journal, lock and temporary
file. Use the exact host error and read-only inspection of ownership, mode,
symlink ancestry, bounded file length and envelope/revision to distinguish access
failure from corrupt contents. An owning host operator may repair verified access
metadata while retaining the exact bytes; corrupt or uncertain contents need an
authenticated revision and owning recovery/result authority for every pending
resource. Never delete/truncate the journal, steal a lock, restore an older
snapshot blindly or infer no effect from PID/path absence. Withhold activation
until that diagnosis and recovery are complete.

Symlinked userData ancestry (including a symlinked ~/.config layout) is unsupported
by the no-follow durable journal policy. It is a fail-closed storage limitation,
not proof of an unused checkout. Do not change path policy, follow the link or
remove custody state to enable the capability; use an explicitly supported host
storage layout and qualified owning recovery instead.

Rollback before any custody state exists may revert the source commit. Once
v3 effects state exists, reverting to a v2-only reader rejects its envelope and
**refuses every local Start/admission**, not only the recorded checkout. This is
the global unreadable-effects behavior, including an otherwise empty v3 effects
file. Removing a provider registration or disabling its consumer does not make
that old reader compatible.

Preserve both journals, locks, temporary files and pending operation evidence.
Restore a qualified forward reader that understands v3 (or retain the compatible
reader while reverting unrelated code), verify its exact state and owning
reconciliation before resuming affected operations. Do not delete, truncate,
restore an older snapshot or rewrite version fields to force a downgrade.
The public wire remains v1; forward readers preserve v1/v2 retired receipts,
while private v3 prevents old readers treating refused receipts as retired.
After activation, remove the producer's coverage registration to withhold the
capability while retaining journals and unresolved fences. Code rollback never
restores a removed checkout; branch/source/material preservation proof remains
independently required.

## Validation

The checked-in fixture uses the standard Vitest import and Node runtime pool:

```text
ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/runtime/worktree-custody.test.mjs --maxWorkers=1
```

It loads syntax-transformed production modules and exercises durable bindings,
consumer refusals, fence races, crash/replay, positive key-bound read-only
reconciliation, latest-generation inventory, path reuse, and the actual fixed
native effect with Git replaced by a fixture-only port. No real Git removal,
terminal/process signal, host cleanup or app launch is performed. Full type,
lint, Vitest, RPC/client compatibility and application checks remain required
under the coordinator's later resource admission.

## Physical-cleanup limitation and bounded follow-on

The fixed 4,096-entry / 2,048-file / 1-GiB / ten-second whole-checkout budgets are
required policy and remain unchanged. Typical repository worktrees exceed them.
This foundation proves neither large-checkout cleanup, throughput nor bytes freed;
full physical cleanup and host/provider activation remain open.

A separate bounded producer follow-on may enroll only producer-created orphan
worker-run temporary directories beneath an exact producer-owned temporary root.
It needs immutable owner/product/task/instance/generation, creation provenance,
committed last-resource release, positive preservation/external/recovery proofs,
exclusive admission through deletion, and durable keyed results under the same
aggregate and per-effect policy budgets. It must refuse symlinks, shared material,
source/history/branches and uncertain outcomes. This requires its own reviewed
resource-kind contract and provider; none is installed here. It cannot split a
worktree or partition its material to evade the required whole-checkout limits.
