import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { splitWorktreeId } from '../../shared/worktree/id'
import { WORKTREE_CUSTODY_CAPABILITY } from '../../shared/worktree/custody'
import type { Worktree } from '../../shared/worktree/types'
import {
  WorktreeCustodyAuthority,
  WorktreeCustodyAdmissionError,
  type CustodyCoverage
} from './worktree-custody-authority'
import { WorktreeCustodyFileJournal } from './worktree-custody-journal'
import type { CustodyFenceOwner, CustodyJournal } from './worktree-custody-records'
import { heldOrcadInstanceLock } from '../orcad/orcad-held-instance-lock'
import { OrchestrationError } from './orchestration/orchestration-error'
import type { OrchestrationDb } from './orchestration/db'
import { WORKER_RELEASABLE_STATES } from './orchestration/worker-terminal-ownership'
import type { WorktreeCustodyResource } from '../../shared/worktree/custody'
import type { WorkerTerminalHostScope } from '../../shared/worker-terminal-host-scope'
import { registerCustodyShutdownAuthority } from './worktree-custody-profile-lifecycle'

export { WorktreeCustodyAdmissionError } from './worktree-custody-authority'

const authorities = new Map<string, WorktreeCustodyAuthority>()
const SETTLED_DISPATCH_STATUSES = ['completed', 'failed', 'circuit_broken']

/** The exclusive desktop/orcad/serve profile lock this process holds now, if any. */
export function custodyFenceOwnerWitness(): CustodyFenceOwner | null {
  const record = heldOrcadInstanceLock()?.record
  if (!record) {
    return null
  }
  const { pid, startedAtMs, linuxStartTicks, bootId, nonce, identity, machineIdentity } = record
  return {
    pid,
    startedAtMs,
    nonce,
    identity,
    ...(linuxStartTicks ? { linuxStartTicks } : {}),
    ...(bootId ? { bootId } : {}),
    ...(machineIdentity ? { machineIdentity } : {})
  }
}

export function nativeWorktreeCustody(_runtimeId?: string): WorktreeCustodyAuthority | null {
  if (!hasAppEnvironment() || process.platform === 'win32') {
    return null
  }
  const directory = join(getAppEnvironment().getPath('userData'), 'worktree-custody-v1')
  const existing = authorities.get(directory)
  if (existing) {
    return existing
  }
  const custody = new WorktreeCustodyAuthority(
    new WorktreeCustodyFileJournal(
      join(getAppEnvironment().getPath('userData'), 'worktree-custody-effects-v1')
    ),
    randomUUID(),
    Date.now,
    new WorktreeCustodyFileJournal(directory),
    custodyFenceOwnerWitness
  )
  authorities.set(directory, custody)
  registerCustodyShutdownAuthority(getAppEnvironment().getPath('userData'), custody)
  return custody
}

/** The fixed native effect's own durable intent/result store, separate from custody effects. */
export function nativeWorktreeCustodyResultJournal(): CustodyJournal | null {
  if (!hasAppEnvironment() || process.platform === 'win32') {
    return null
  }
  return new WorktreeCustodyFileJournal(
    join(getAppEnvironment().getPath('userData'), 'worktree-custody-results-v1')
  )
}

export function nativeWorktreeCustodyCapabilities(runtimeId: string): string[] {
  try {
    return nativeWorktreeCustody(runtimeId)?.supported ? [WORKTREE_CUSTODY_CAPABILITY] : []
  } catch {
    return []
  }
}

/** Native providers must fence their real consumers; this is deliberately absent from RPC. */
export function installNativeWorktreeCustodyCoverage(
  owner: string,
  coverage: CustodyCoverage,
  runtimeId?: string
): () => void {
  const custody = nativeWorktreeCustody(runtimeId)
  if (!custody) {
    throw new Error('custody_host_unsupported')
  }
  return custody.installCoverage(owner, coverage)
}

export function admitWorktreeCustody(
  worktreeId: string,
  path?: string,
  hostId?: string | null,
  reopen = true
): () => void {
  if (hostId && hostId !== 'local') {
    return () => {}
  }
  const exactPath = path ?? splitWorktreeId(worktreeId)?.worktreePath
  if (!exactPath) {
    return () => {}
  }
  return nativeWorktreeCustody()?.admit(worktreeId, exactPath, reopen) ?? (() => {})
}

export function assertWorktreeCustodyAdmission(
  worktreeId: string,
  path?: string,
  hostId?: string | null
): void {
  if (hostId && hostId !== 'local') {
    return
  }
  const exactPath = path ?? splitWorktreeId(worktreeId)?.worktreePath
  if (exactPath) {
    nativeWorktreeCustody()?.checkAdmission(worktreeId, exactPath)
  }
}

export function admitOrchestrationWorktreeCustody(
  worktreeId: string,
  path?: string,
  hostId?: string | null
): () => void {
  try {
    return admitWorktreeCustody(worktreeId, path, hostId)
  } catch (error) {
    if (!(error instanceof WorktreeCustodyAdmissionError)) {
      throw error
    }
    throw new OrchestrationError(
      'worktree_custody_refused',
      'Workspace custody prevents this operation.',
      {
        effectsApplied: false,
        worktreeId,
        reason: error.message
      }
    )
  }
}

/** Admits a dispatch authority's worktree; an absent or unknown host scope never reads as local. */
export function admitDispatchAuthorityWorktreeCustody(
  worktreeId: string,
  hostScope: WorkerTerminalHostScope | undefined
): () => void {
  const kind = hostScope?.kind
  switch (kind) {
    case 'local':
    case 'wsl':
    case 'ssh':
      return admitOrchestrationWorktreeCustody(worktreeId, undefined, kind)
    default:
      throw new OrchestrationError(
        'worktree_custody_refused',
        'Workspace custody prevents this operation.',
        { effectsApplied: false, worktreeId, reason: 'host_scope_unknown' }
      )
  }
}

export function claimWorkerWorktreeCustody(
  worktree: Pick<Worktree, 'id'> &
    Partial<Pick<Worktree, 'path' | 'instanceId' | 'hostId' | 'projectId' | 'isMainWorktree'>>,
  dispatchId: string,
  taskId: string,
  effectsApplied = false
): void {
  // Legacy, folder and remote copies need their own host authority, never this host's fallback.
  const parsed = splitWorktreeId(worktree.id)
  if (!parsed || parsed.worktreePath !== worktree.path) {
    return
  }
  if (
    !worktree.path ||
    !worktree.instanceId ||
    !worktree.projectId ||
    worktree.hostId !== 'local' ||
    worktree.isMainWorktree !== false
  ) {
    return
  }
  try {
    nativeWorktreeCustody()?.claim(
      {
        worktreeId: worktree.id,
        path: worktree.path,
        instanceId: worktree.instanceId,
        hostId: worktree.hostId,
        owner: 'orchestration',
        product: worktree.projectId,
        task: taskId
      },
      `dispatch:${dispatchId}`
    )
  } catch (error) {
    if (error instanceof WorktreeCustodyAdmissionError) {
      throw new OrchestrationError(
        'worktree_custody_refused',
        'Workspace custody prevents this worker claim.',
        {
          effectsApplied,
          worktreeId: worktree.id,
          reason: error.message
        }
      )
    }
    console.warn('[worktree-custody] producer claim pending', { dispatchId })
  }
}

export function releaseWorkerWorktreeCustody(
  database: Pick<OrchestrationDb, 'db'>,
  dispatchId: string
): void {
  try {
    const custody = nativeWorktreeCustody()
    const resource = custody?.claimedResource(`dispatch:${dispatchId}`)
    if (!custody || !resource || resource.owner !== 'orchestration' || database.db.isTransaction) {
      return
    }
    // worker_dispatches and dispatch_contexts share the Dispatch id; both must settle for the claimed task.
    const worker = database.db
      .prepare(
        `SELECT wd.state, wd.worktree_id, dc.task_id, dc.status AS dispatch_status
        FROM worker_dispatches wd INNER JOIN dispatch_contexts dc ON dc.id = wd.dispatch_id
        WHERE wd.dispatch_id = ?`
      )
      .get(dispatchId)
    if (
      !worker ||
      !WORKER_RELEASABLE_STATES.some((state) => state === worker.state) ||
      !SETTLED_DISPATCH_STATUSES.includes(String(worker.dispatch_status)) ||
      worker.worktree_id !== resource.worktreeId ||
      worker.task_id !== resource.task
    ) {
      return
    }
    const resources = database.db
      .prepare(`SELECT worktree_id, ownership_state, release_state
      FROM worker_terminal_resources WHERE owner_dispatch_id = ? OR origin_dispatch_id = ?
      OR EXISTS (SELECT 1 FROM json_each(prior_owner_dispatch_ids) WHERE value = ?) LIMIT 2049`)
      .all(dispatchId, dispatchId, dispatchId)
    if (
      resources.length === 0 ||
      resources.length > 2048 ||
      resources.some(
        (entry) =>
          entry.worktree_id !== resource.worktreeId ||
          entry.ownership_state !== 'released' ||
          entry.release_state !== 'released'
      )
    ) {
      return
    }
    custody.release(`dispatch:${dispatchId}`, `native-worker-release:${dispatchId}`)
  } catch (error) {
    // A legacy or reopened claim remains unknown; worker settlement must stay committed.
    console.warn('[worktree-custody] release proof pending', {
      dispatchId,
      reason: error instanceof Error ? error.message : 'custody_release_unproven'
    })
  }
}

export function queueWorkerWorktreeCustodyRelease(
  database: Pick<OrchestrationDb, 'db'>,
  dispatchId: string
): void {
  // Re-read committed ownership after the synchronous outer transaction; observation retries durable rows after restart.
  queueMicrotask(() => releaseWorkerWorktreeCustody(database, dispatchId))
}

export function reconcileWorkerWorktreeCustodyRelease(
  database: Pick<OrchestrationDb, 'db'>,
  resource: WorktreeCustodyResource
): void {
  const claim = nativeWorktreeCustody()?.producerClaim(resource)
  if (claim?.startsWith('dispatch:')) {
    releaseWorkerWorktreeCustody(database, claim.slice('dispatch:'.length))
  }
}
