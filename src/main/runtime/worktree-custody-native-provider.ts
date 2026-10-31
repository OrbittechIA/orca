import type {
  WorktreeCustodyObservation,
  WorktreeCustodyResource
} from '../../shared/worktree/custody'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type { OrcaRuntimeService } from './orca-runtime'
import type { WorktreePreservation } from './worktree-custody-preservation'
import type { NativeWorktreeCustodyProvider } from './worktree-custody-retirement'
import type { CustodyFenceOwner } from './worktree-custody-records'
import type { WorktreeSelectionAuthority } from './worktree-custody-selections'
import {
  WHOLE_CHECKOUT_RETIREMENT_POLICY,
  type CheckoutRetirementPolicy
} from './worktree-custody-checkout-policy'

const PRODUCER_OWNER = 'orchestration'
const INSTALL_DRAIN_MS = 5_000
const RECOVERABLE_WORKER_STATES = ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown']

type DomainProof = WorktreeCustodyObservation['domains'][number]

/** Host-only port for consumers outside Orca's registries; no RPC, CLI or caller data can supply it. */
export type ExternalConsumerAuthority = {
  observe: (resource: WorktreeCustodyResource) => Promise<Omit<DomainProof, 'domain'>>
  acquire: (
    resource: WorktreeCustodyResource
  ) => Promise<{ check: () => boolean; release: () => void }>
}

export type NativeCustodyProviderPorts = {
  runtime: Pick<
    OrcaRuntimeService,
    | 'showManagedWorktree'
    | 'openedAgentSessionRecordStore'
    | 'getWorkspaceSessionForWorktree'
    | 'getOrchestrationDb'
    | 'requireStore'
  >
  /** Null: no journal attached in this host; the durable lease fields still decide. */
  structuredWork: (
    sessionId: string
  ) => { working(): boolean; hasActionablePrompt(): boolean } | null | undefined
  removals: () => Iterable<{ worktreeId: string; worktreePath: string }>
  /** Desktop watcher roots, including suspended and in-flight installs. */
  desktopWatchRoots: () => Iterable<string>
  /** Runtime file-watch leases on overlapping roots, across every runtime and connection. */
  runtimeWatchLeases: (path: string) => number
  /** Fences new watcher and fresh PTY installs for overlapping roots until released. */
  fenceInstalls: (path: string) => { ready: Promise<void>; release: () => void }
  preservation: (path: string) => Promise<WorktreePreservation>
  external: ExternalConsumerAuthority | null
  /** Host-only authority for paired/mobile clients' current workspace selection. */
  pairedSelection: WorktreeSelectionAuthority | null
  /** Exclusive profile lock: the holder now, and the lock's own exit judgment for a prior holder. */
  profileLock: {
    current: () => CustodyFenceOwner | null
    exited: (owner: CustodyFenceOwner) => boolean
  }
  now?: () => number
  /** Native adoption package only, after Core accepts the exact policy and aggregate caps. */
  checkoutPolicy?: CheckoutRetirementPolicy
  releaseHistory?: NativeWorktreeCustodyProvider['recoverRelease']
}

export type NativeCustodyProvider = NativeWorktreeCustodyProvider & {
  /** True only when every domain has an owning authority; otherwise the host installs observation only. */
  readonly ready: boolean
}

function overlapping(left: string, right: string): boolean {
  const a = normalizeRuntimePathForComparison(left)
  const b = normalizeRuntimePathForComparison(right)
  return isPathInsideOrEqual(a, b) || isPathInsideOrEqual(b, a)
}

async function withinDeadline(ready: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      ready.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createNativeWorktreeCustodyProvider(
  ports: NativeCustodyProviderPorts
): NativeCustodyProvider {
  const now = ports.now ?? Date.now
  const registeredConsumers = (path: string) =>
    [...ports.desktopWatchRoots()].filter((root) => overlapping(root, path)).length +
    ports.runtimeWatchLeases(path)

  const observe = async (
    resource: WorktreeCustodyResource
  ): Promise<WorktreeCustodyObservation> => {
    const unproven: WorktreeCustodyObservation = {
      resource,
      observedAt: now(),
      disposition: 'unknown',
      releaseProof: null,
      domains: []
    }
    const worktree = await ports.runtime.showManagedWorktree(`id:${resource.worktreeId}`)
    // Native product is the physical projectId; a native Task carries no product to compare.
    if (
      resource.owner !== PRODUCER_OWNER ||
      resource.hostId !== 'local' ||
      worktree.id !== resource.worktreeId ||
      worktree.path !== resource.path ||
      worktree.instanceId !== resource.instanceId ||
      worktree.hostId !== 'local' ||
      worktree.projectId !== resource.product ||
      worktree.isMainWorktree ||
      worktree.isBare
    ) {
      return unproven
    }
    const domains: DomainProof[] = []
    const stamp = (entry: Omit<DomainProof, 'observedAt'>) =>
      domains.push({ ...entry, observedAt: now() })
    const removing = [...ports.removals()].some(
      (removal) =>
        removal.worktreeId === resource.worktreeId ||
        overlapping(removal.worktreePath, resource.path)
    )

    const store = ports.runtime.openedAgentSessionRecordStore()
    const records = store
      ? store.listRecords().filter((record) => record.location.workspaceId === resource.worktreeId)
      : null
    if (records) {
      // The opened single-writer store is this profile's durable session registry.
      const held = records.some((record) => {
        const work = ports.structuredWork(record.sessionId)
        return (
          record.lease.claimStatus !== 'released' ||
          record.lease.unreconciled ||
          record.lease.handoffStage !== null ||
          record.lease.reservedSpawnToken !== null ||
          work?.working() === true ||
          work?.hasActionablePrompt() === true
        )
      })
      stamp({
        domain: 'structured-session',
        complete: true,
        active: records.some((record) => record.lease.claimStatus === 'live'),
        held,
        proof: `native-agent-session-store:${records.length}`
      })
    }

    const session = ports.runtime.getWorkspaceSessionForWorktree(resource.worktreeId)
    if (session && records) {
      const recoverable = ports.runtime
        .getOrchestrationDb()
        .db.prepare(
          `SELECT COUNT(*) AS count FROM worker_dispatches WHERE worktree_id = ?
          AND state IN (SELECT value FROM json_each(?))`
        )
        .get(resource.worktreeId, JSON.stringify(RECOVERABLE_WORKER_STATES))
      const sleeping = Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
        (record) => record.worktreeId === resource.worktreeId
      ).length
      const reserved = records.some(
        (record) => record.lease.reservedSpawnToken !== null || record.lease.unreconciled
      )
      const workers = Number(recoverable?.count ?? Number.NaN)
      stamp({
        domain: 'recovery',
        complete: Number.isSafeInteger(workers),
        active: false,
        held: sleeping > 0 || removing || reserved || workers !== 0,
        proof: `native-recovery:sleep=${sleeping}:workers=${workers}:removal=${removing}`
      })
    }

    if (session) {
      const id = resource.worktreeId
      // Open editor, browser and unified tabs may hold unsaved or client-visible state.
      const tabs =
        (session.openFilesByWorktree?.[id]?.length ?? 0) +
        (session.browserTabsByWorktree?.[id]?.length ?? 0) +
        (session.clientHostedBrowserPagesByWorktree?.[id]?.length ?? 0) +
        (session.unifiedTabs?.[id]?.length ?? 0)
      const desktop = ports.runtime.requireStore().getWorkspaceSession?.('local')
      const current =
        session.activeWorktreeId === id ||
        desktop?.activeWorktreeId === id ||
        ports.pairedSelection?.selects(id) === true
      stamp({
        domain: 'workspace',
        // Without paired-client selection authority the domain can only add holds.
        complete: ports.pairedSelection !== null && ports.pairedSelection.complete !== false,
        active: current,
        held:
          current ||
          removing ||
          tabs > 0 ||
          worktree.workspaceStatus !== 'completed' ||
          worktree.isPinned === true ||
          worktree.childWorktreeIds.length > 0,
        proof: `native-workspace-session:${resource.instanceId}:tabs=${tabs}:paired=${ports.pairedSelection ? 'covered' : 'unrepresented'}`
      })
    }

    const consumers = registeredConsumers(resource.path)
    stamp({
      domain: 'registered-consumer',
      complete: true,
      active: consumers > 0,
      held: consumers > 0,
      proof: `native-watch-registries:${consumers}`
    })

    if (ports.external) {
      stamp({ domain: 'external-consumer', ...(await ports.external.observe(resource)) })
    }

    // Preservation is the costly Git read; any positive hold already refuses without it.
    if (domains.some((entry) => entry.active === true || entry.held === true)) {
      return { ...unproven, observedAt: now(), domains }
    }
    const preservation = await ports.preservation(resource.path)
    stamp({
      domain: 'preservation',
      complete: preservation.preserved || preservation.reason !== 'git_preservation_unavailable',
      active: false,
      held: !preservation.preserved,
      proof: preservation.preserved ? preservation.proof : `refused:${preservation.reason}`
    })
    return { ...unproven, observedAt: now(), domains }
  }

  return {
    owner: PRODUCER_OWNER,
    ready:
      ports.external !== null &&
      ports.pairedSelection !== null &&
      ports.releaseHistory !== undefined &&
      ports.checkoutPolicy !== undefined,
    retirementPolicy: ports.checkoutPolicy ?? WHOLE_CHECKOUT_RETIREMENT_POLICY,
    observe,
    acquire: async (resource) => {
      const selectionGeneration = ports.pairedSelection?.generation
      // Admission already refuses Orca entrypoints for the fenced path; this also closes watcher/PTY installs.
      const installs = ports.fenceInstalls(resource.path)
      let external: { check: () => boolean; release: () => void } | null = null
      try {
        if (!(await withinDeadline(installs.ready, INSTALL_DRAIN_MS))) {
          throw new Error('custody_consumer_install_pending')
        }
        if (registeredConsumers(resource.path) > 0) {
          throw new Error('custody_registered_consumer_held')
        }
        if (!ports.external) {
          throw new Error('custody_external_consumer_unproven')
        }
        if (!ports.pairedSelection || ports.pairedSelection.selects(resource.worktreeId)) {
          throw new Error('custody_selection_held')
        }
        external = await ports.external.acquire(resource)
      } catch (error) {
        external?.release()
        installs.release()
        throw error
      }
      const grant = external
      let released = false
      return {
        // Synchronous and side-effect-free: only registry reads.
        check: () =>
          !released &&
          ports.pairedSelection?.generation === selectionGeneration &&
          ports.pairedSelection?.selects(resource.worktreeId) === false &&
          registeredConsumers(resource.path) === 0 &&
          grant.check(),
        release: () => {
          if (released) {
            return
          }
          released = true
          try {
            grant.release()
          } finally {
            installs.release()
          }
        }
      }
    },
    // No owning durable result store exists; an unknown effect stays unknown.
    reconcile: async (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: false,
      proof: null
    }),
    // Grants live in the capturing process; its successor lock plus its proven exit settle them.
    recoverFence: async (fence, owner) => {
      const current = owner ? ports.profileLock.current() : null
      if (
        !owner ||
        !current ||
        ((owner.linuxStartTicks === undefined || owner.bootId === undefined) &&
          owner.startedAtMs === null) ||
        owner.nonce === current.nonce ||
        owner.identity !== current.identity ||
        !owner.machineIdentity ||
        owner.machineIdentity !== current.machineIdentity ||
        !ports.profileLock.exited(owner)
      ) {
        return { fence, recovered: false, proof: null }
      }
      return {
        fence,
        recovered: true,
        proof: `profile-lock-successor:${current.nonce}:exited:${owner.nonce}:${owner.pid}`
      }
    },
    // Durable producer rows lack consumer admission history across the gap; keep old epochs unknown.
    recoverRelease:
      ports.releaseHistory ?? (async (release) => ({ release, confirmed: false, proof: null }))
  }
}
