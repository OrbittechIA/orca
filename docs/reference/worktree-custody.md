# Native worktree custody v1

This is a source foundation for a trusted material-lifecycle adapter. It does not
certify existing worktrees for cleanup. No complete external-consumer or
preservation provider is installed by default. Consequently the runtime does not
advertise `worktree.custody.no-stop.v1` until native host code installs coverage.
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

| operation | Required fields beyond schemaVersion/operation | Response fields beyond schemaVersion |
| --- | --- | --- |
| list | none | supported, authorityId, resources, complete, scope |
| observe | resource | observation |
| capture | resource | fence |
| check | fence | valid=true, or refusal |
| cancel | fence | cancelled=true, or refusal |
| retire | fence, key | outcome |
| reconcile | resource, key | outcome, or null when never dispatched |

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

`observation` is exactly `{resource,observedAt,disposition,releaseProof,domains}`.
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
worktrees. It exposes the latest claim generation for each exact host/path and
omits confirmed retired tombstones. Earlier receipts remain available by exact
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
Publication failure is pending proof and does not undo native worker settlement.
A later start/reopen invalidates an already released generation durably.

Actual admission guards cover the shared renderer/runtime PTY spawn operation
(including restore/recovery/reattach), high-level runtime terminal/agent creation,
structured attach/resume/ensure acquisition, send/queue/session mutations before
journal changes, explicit workspace resume, workspace wake/reopen, activation,
interactive removal, metadata/parent-lineage writes,
automatic coordinator dispatch, direct terminal/chat dispatch, local worker-start
reservation/placement, and runtime known-file/worktree-file target resolution.
PTY spawn and structured acquisition hold admissions across their awaits; capture
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
check/release/reconcile ports must cover **all** remaining producer and consumer
claims, including future ingress, and positively attest preservation. A process
scan alone cannot do so. Provider proof cannot erase a native positive hold.
The fixed native retirement effect is supplied by Orca, not by RPC data. Merely
adding an interface or setting a feature flag cannot enable the capability.
No complete provider is installed in this change; Root's Core/provider follow-on
must supply and review that authority before a positive retirement is possible.

## Crash, reconciliation and rollback

The private bounded `worktree-custody-v1/custody.json` journal uses exclusive
writer admission, exact revision checks, atomic replacement, file fsync and
directory fsync. Unknown/corrupt/symlink state refuses custody; a leftover writer
lock is not stolen using age or PID absence. Capture is durable before an async
grant is requested. Dispatch is durable before effects. Changed options/keys do
not reopen an unresolved generation. Fences survive a crash conservatively;
prior-incarnation cancellation is refused. An undispatched fence from a crashed
authority remains unknown until an owning recovery authority can prove safe
settlement; there is no automatic lease-expiry release.

Reconcile is read-only: it dispatches nothing and rewrites no receipt. A stored
retired result is authoritative for its exact key even after the checkout leaves
inventory. Otherwise a trusted owning native result query must positively bind
the same resource/key and a nonempty proof identifier; the in-process return is
`{resource,key,confirmed,proof}` and native code checks that binding. Absence alone
remains unknown. A positive query can cache
settlement for this incarnation's admission decisions without changing the
durable original. Restart requires that proof again. Confirmed retired old
instances permit fresh path reuse; unknown/dispatched old instances continue
fencing overlapping paths. The fixed native provider delegates unknown-outcome
confirmation to its trusted result authority; it cannot manufacture confirmation
from an absent directory.

Rollback before activation is to revert the source commit. After activation,
remove the producer's coverage registration to withhold capability and preserve
the journal and unresolved fences. Do not delete journal state to clear an
unknown operation. Reverting code does not restore a removed checkout; retained
branch/source/material preservation proof remains required independently.

## Validation

The stdlib fixture suite can run without dependencies:

```text
ORCA_BACKGROUND_LAUNCH=1 node --max-old-space-size=96 --disable-warning=ExperimentalWarning --test --test-concurrency=1 src/main/runtime/worktree-custody.test.mjs
```

It loads syntax-transformed production modules and exercises durable bindings,
consumer refusals, fence races, crash/replay, positive key-bound read-only
reconciliation, latest-generation inventory, path reuse, and the actual fixed
native effect with Git replaced by a fixture-only port. No real Git removal,
terminal/process signal, host cleanup or app launch is performed. Full type,
lint, Vitest, RPC/client compatibility and application checks remain required
under the coordinator's later resource admission.
