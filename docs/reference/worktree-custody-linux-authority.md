# Linux external-custody authority qualification

This is a prepared engineering and adoption contract, not an installed helper or
a qualified native port. No code, marks, service, permissions, worktree or profile
was changed on the host. This source keeps retirement capability unadvertised.

## Current-boot evidence

On 2026-10-31 the bounded, approved reads reported kernel `6.8.0-147-generic` and
`/sys/kernel/security/lsm` = `lockdown,capability,landlock,yama,apparmor`.
`/boot/config-6.8.0-147-generic` has `CONFIG_BPF_LSM=y`, `CONFIG_BPF_SYSCALL=y`,
`CONFIG_SECURITY_PATH=y`, `CONFIG_FANOTIFY_ACCESS_PERMISSIONS=y` and BTF support,
but its default `CONFIG_LSM` excludes BPF. `/proc/config.gz` was absent (ENOENT).
The coordinator separately proved a root fanotify content-group FD could be opened
and closed. No persistent marks or policy attachment were made.

Fanotify permission notification alone does not authorize this protocol. A pathname
`chdir` or `chroot` can admit a cwd/root consumer without opening a file; already-open
descriptors and mappings need separate owning proof. Scanning processes before a
removal leaves an admission race. The natural BPF-LSM enforcement route is not active
on this boot. No supported external fence is claimed, and no reboot or boot change is
authorized by this source task. This is a specific current-host limitation, rather
than a claim that all Linux hosts lack an available native seam.

## Required native implementation

A reviewed broker/LSM implementation must close every relevant admission before
the all-UID metadata census and hold that closure through the fixed Git result.
It must cover cwd/root, open descriptors, existing/new mappings, inherited access,
descriptor transfer, fork/exec, bind/mount aliases and namespace changes. Candidate
hooks include `path_chdir`, `path_chroot`, `file_open`, `mmap_file`, `file_mprotect`,
`file_receive`, task lifecycle and mount/path/inode permission hooks. This list is
an engineering checklist, not a proof that those hooks alone suffice. Mount, PID or
user namespaces and hook coverage must be positively qualified; unsupported views
or bypasses refuse the resource.

The census reads metadata only for every UID and every thread: cwd/root identity,
FD identity, and mapping device/inode. It must not persist command lines, process
contents, addresses or file contents. Read denial, truncation, inconsistent identity,
unproven task disappearance, unstable enumeration, exceeded counts/time/memory or
event overflow mean UNKNOWN. Existing consumers mean HELD. Neither result permits
signals, stop, killing, global pause, permission changes or resource relocation.

The broker needs a kernel-backed, failure-visible admission-history incarnation.
Optional Orca journal writes cannot provide it. A resource's kernel admission
counter/dirty state must survive main-process failure, invalidate seals after any
intervening admission, and never infer continuity after broker/monitor loss, map
replacement, boot change or an unobserved interval. Clean-epoch seals are usable
only with that exact independent history proof and retained producer binding.
After uncertainty the old generation stays unknown; absence and age do not repair it.

## Narrow protocol and privilege boundary

Use one root-owned Unix broker socket, peer credentials and pidfds. There is no
shell, arbitrary command executor, arbitrary path operation or user RPC for adopting
a helper. A reviewed local installation must bind the authorized native application
identity, UID, data-root identity, protocol/build digests and Git executable digest.
The broker accepts resource handles via SCM_RIGHTS and validates them against its
native enrollment allowlist; a caller-supplied path is not authority. Bind each
request to resource key, device/inode, instance, release generation, owning native
grant, caller process incarnation and fixed-effect key.

Only ENROLL/OBSERVE/ACQUIRE/STATUS/FIXED_RETIRE/RECONCILE/RELEASE are candidates.
ENROLL must originate from the trusted native producer, not free JSON asserting a
released disposition. ACQUIRE installs only an exact-resource fence and completes
the census. STATUS updates an in-memory owning grant; Orca's synchronous `check()`
reads its cached validity and generation, doing no syscalls or process walk.
Loss of the transport or native owner invalidates the cache immediately.

FIXED_RETIRE may execute only the pinned Git worktree-removal operation as the
resource owner, with branch deletion disabled, fixed argument construction and a
minimal reviewed environment. It cannot designate an arbitrary caller PID or all
descendants as trusted: only the broker-owned fixed effect receives the kernel
exemption. Unexpected execution/fork behavior refuses or makes the outcome unknown.
The existing native fixed-effect composition still needs this broker-owned effect
bridge; the current `ExternalConsumerAuthority` acquire/check interface cannot by
itself authorize a privileged helper's effect exemption. No bridge is fabricated here.

Durable intent must precede the effect and a resource/key/owner-bound receipt follows
its actual native result. The existing native result journal handles Orca-side lost
responses, but the broker also needs an owning result across its own crash window.
RECONCILE is read-only; missing paths are never evidence and removal is never resent
for an uncertain key. Release after peer/broker death must be implemented in the
kernel using verified process incarnation, while admission-history uncertainty stays
visible. A timer or a missing heartbeat cannot prove process death.

The exact required Linux capabilities, loader, hook program, binary digests, service
sandbox and installation paths remain unimplemented/unqualified. A generic root
service template would conceal that work, so no installable helper is presented as
complete. Root must review the concrete loader/broker/effect bridge before any
privileged build, execution, attachment or installation. The current-boot LSM gap
additionally requires a separately authorized host-maintenance decision; this task
does not grant it.

## Authentic disposable qualification plan

Root creates a disposable local repository, retained shared branch and completed
native Dispatch with an actually released native terminal resource. Root records
the exact native worktree/instance/product/task/generation and real 7-day/72-hour
policy provenance; dates are not forged to grant deletion. A separate test policy
may exercise the native primitive directly without claiming Core retention passed.
The fixture contains more than 2,048 tracked files to exercise the approved whole
checkout policy, with all data retained in the shared branch/commit.

After real client selection reports and the qualified helper census, capture the
native grant and invoke the fixed native effect once. Drop only the disposable
client's response after the owning result commits, reconnect, and reconcile the
same resource/key. Require one real Git removal, a durable retired receipt, retained
branch/commit and session/profile history, and no resend. Also exercise a loss before
the owning result commits: it must remain unknown, even if the path disappeared.

Negative controls retain a live cwd/root/FD/mapping holder, a late chdir after the
census, descriptor transfer/fork/namespace aliases, a watcher, an unknown phone,
untracked/ignored unique material, a foreign identity, a legacy/unsealed epoch and
failed history writes. Each must refuse or remain unknown, with no consumer stopped.
Destroy only explicitly owned disposable fixtures after review. Source fixtures with
stubbed native effects are not this qualification and cannot satisfy it.
