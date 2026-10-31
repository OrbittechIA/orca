import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { splitWorktreeId } from '../../shared/worktree/id'
import { WORKTREE_CUSTODY_CAPABILITY } from '../../shared/worktree/custody'
import type { Worktree } from '../../shared/worktree/types'
import { WorktreeCustodyAuthority, type CustodyCoverage } from './worktree-custody-authority'
import { WorktreeCustodyFileJournal } from './worktree-custody-journal'

let authority: { directory: string; runtimeId: string | null; custody: WorktreeCustodyAuthority } | null = null

export function nativeWorktreeCustody(runtimeId?: string): WorktreeCustodyAuthority | null {
  if (!hasAppEnvironment() || process.platform === 'win32') return null
  const directory = join(getAppEnvironment().getPath('userData'), 'worktree-custody-v1')
  if (authority?.directory === directory &&
    (!runtimeId || !authority.runtimeId || authority.runtimeId === runtimeId)) {
    authority.runtimeId ??= runtimeId ?? null
    return authority.custody
  }
  const custody = new WorktreeCustodyAuthority(new WorktreeCustodyFileJournal(directory), randomUUID())
  authority = { directory, runtimeId: runtimeId ?? null, custody }
  return custody
}

export function nativeWorktreeCustodyCapabilities(runtimeId: string): string[] {
  try {
    return nativeWorktreeCustody(runtimeId)?.supported ? [WORKTREE_CUSTODY_CAPABILITY] : []
  } catch {
    return []
  }
}

/** Native providers must fence their real consumers; this is deliberately absent from RPC. */
export function installNativeWorktreeCustodyCoverage(owner: string, coverage: CustodyCoverage, runtimeId?: string): () => void {
  const custody = nativeWorktreeCustody(runtimeId)
  if (!custody) throw new Error('custody_host_unsupported')
  return custody.installCoverage(owner, coverage)
}

export function admitWorktreeCustody(worktreeId: string, path?: string, hostId?: string | null): () => void {
  if (hostId && hostId !== 'local') return () => {}
  const exactPath = path ?? splitWorktreeId(worktreeId)?.worktreePath
  if (!exactPath) return () => {}
  return nativeWorktreeCustody()?.admit(worktreeId, exactPath) ?? (() => {})
}

export function assertWorktreeCustodyAdmission(worktreeId: string, path?: string, hostId?: string | null): void {
  admitWorktreeCustody(worktreeId, path, hostId)()
}

export function claimWorkerWorktreeCustody(
  worktree: Pick<Worktree, 'id'> & Partial<Pick<Worktree, 'path' | 'instanceId' | 'hostId' | 'projectId' | 'isMainWorktree'>>,
  dispatchId: string,
  taskId: string
): void {
  // Legacy, folder and remote copies need their own host authority, never this host's fallback.
  const parsed = splitWorktreeId(worktree.id)
  if (!parsed || parsed.worktreePath !== worktree.path) return
  if (!worktree.path || !worktree.instanceId || !worktree.projectId || worktree.hostId !== 'local' || worktree.isMainWorktree !== false) return
  try {
    nativeWorktreeCustody()?.claim({
      worktreeId: worktree.id,
      path: worktree.path,
      instanceId: worktree.instanceId,
      hostId: worktree.hostId,
      owner: 'orchestration',
      product: worktree.projectId,
      task: taskId
    }, `dispatch:${dispatchId}`)
  } catch (error) {
    if (error instanceof Error && error.message === 'worktree_custody_fenced') throw error
    console.warn('[worktree-custody] producer claim pending', { dispatchId })
  }
}

export function releaseWorkerWorktreeCustody(dispatchId: string, resourceId: string): void {
  try {
    const custody = nativeWorktreeCustody()
    if (!custody?.resources().some((resource) => resource.owner === 'orchestration')) return
    custody.release(`dispatch:${dispatchId}`, `native-worker-release:${resourceId}`)
  } catch (error) {
    // A legacy or reopened claim remains unknown; worker settlement must stay committed.
    console.warn('[worktree-custody] release proof pending', {
      dispatchId,
      reason: error instanceof Error ? error.message : 'custody_release_unproven'
    })
  }
}
