import {
  WORKTREE_CUSTODY_DOMAINS,
  type WorktreeCustodyDomain,
  type WorktreeCustodyObservation,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'
import type { OrcaRuntimeService } from './orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

/** Reports only ownership metadata. Missing stores and legacy/unbound consumers remain incomplete. */
export async function observeNativeWorktreeCustody(
  runtime: OrcaRuntimeService,
  resource: WorktreeCustodyResource
): Promise<WorktreeCustodyObservation> {
  const domains: {
    domain: WorktreeCustodyDomain
    observedAt: number
    complete: boolean
    active: boolean | null
    held: boolean | null
    proof: string | null
  }[] = WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
    domain,
    observedAt: Date.now(),
    complete: false,
    active: null,
    held: null,
    proof: null
  }))
  const stamp = (
    domain: (typeof WORKTREE_CUSTODY_DOMAINS)[number],
    complete: boolean,
    active: boolean,
    held: boolean,
    proof: string
  ) => {
    const entry = domains.find((item) => item.domain === domain)
    if (entry) Object.assign(entry, { observedAt: Date.now(), complete, active, held, proof })
  }
  const worktree = await runtime.showManagedWorktree(`id:${resource.worktreeId}`)
  const exact =
    worktree.id === resource.worktreeId &&
    worktree.path === resource.path &&
    worktree.instanceId === resource.instanceId &&
    worktree.hostId === resource.hostId &&
    worktree.projectId === resource.product &&
    !worktree.isMainWorktree &&
    !worktree.isBare
  if (exact) {
    const session = runtime.getWorkspaceSessionForWorktree(resource.worktreeId)
    const sleeping = Object.values(session?.sleepingAgentSessionsByPaneKey ?? {}).filter(
      (record) => record.worktreeId === resource.worktreeId
    )
    stamp('recovery', false, false, sleeping.length > 0, 'native-sleep-records-only')
    const desktop = runtime.requireStore().getWorkspaceSession?.('local')
    const current =
      desktop?.activeWorktreeId === resource.worktreeId &&
      (desktop.activeWorkspaceExecutionHostId === undefined ||
        desktop.activeWorkspaceExecutionHostId === 'local')
    stamp(
      'workspace',
      false,
      current,
      current ||
        worktree.workspaceStatus !== 'completed' ||
        worktree.isPinned ||
        worktree.childWorktreeIds.length > 0,
      `native-desktop-selection-and-instance:${resource.instanceId}`
    )
    try {
      const terminals = await runtime.listTerminals(`id:${resource.worktreeId}`, 10_000, {
        requireFreshPtyLiveness: true,
        includeVisualLayouts: false
      })
      const complete =
        !terminals.truncated &&
        terminals.totalCount === terminals.terminals.length &&
        terminals.hostScope?.hostIds.length === 1 &&
        terminals.hostScope.hostIds[0] === 'local' &&
        terminals.hostScope.omittedHostIds.length === 0
      stamp(
        'terminal',
        complete,
        terminals.terminals.some((terminal) => terminal.connected),
        terminals.terminals.length > 0,
        'native-fresh-pty-and-surface-inventory'
      )
    } catch {
      // A failed inventory retains the unknown domain.
    }
    const store = runtime.openedAgentSessionRecordStore()
    if (store) {
      const records = store
        .listRecords()
        .filter((record) => record.location.workspaceId === resource.worktreeId)
      const host = getStructuredAgentSessionHost()
      const held = records.some((record) => {
        const work = host?.currentWork(record.sessionId)
        return (
          record.lease.claimStatus !== 'released' ||
          record.lease.unreconciled ||
          record.lease.handoffStage !== null ||
          record.lease.reservedSpawnToken !== null ||
          work?.working() === true ||
          work?.hasActionablePrompt() === true
        )
      })
      stamp(
        'structured-session',
        false,
        records.some((record) => record.lease.claimStatus === 'live'),
        held,
        'native-session-leases-and-open-journal-work-only'
      )
    }
    const workers = runtime.getOrchestrationDb().listWorkerTerminalResources({ limit: 10_001 })
    const exactWorkers = workers.filter((worker) => worker.worktreeId === resource.worktreeId)
    const activeDispatch = (status: string) => status === 'pending' || status === 'dispatched'
    const unbound = workers.some(
      (worker) => !worker.worktreeId && activeDispatch(worker.dispatchStatus)
    )
    stamp(
      'dispatch',
      workers.length < 10_001 && !unbound,
      exactWorkers.some((worker) => activeDispatch(worker.dispatchStatus)),
      exactWorkers.some(
        (worker) =>
          worker.pendingInput || worker.pendingApproval || worker.terminalState !== 'released'
      ),
      'native-dispatch-and-worker-release-inventory'
    )
  }
  return {
    resource,
    observedAt: Date.now(),
    disposition: 'unknown',
    releaseProof: null,
    domains: exact ? domains : []
  }
}
