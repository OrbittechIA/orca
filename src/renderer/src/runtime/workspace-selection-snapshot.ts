import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '@/store/types'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { isWebClientLocation } from '@/lib/web-client-location'

const mountedReaders = new Set<() => ReadonlySet<string>>()
let browserEnvironmentId: string | null = null
export function setCustodyBrowserEnvironment(id: string): void {
  browserEnvironmentId = id
}
export function hasCustodyBrowserEnvironment(): boolean {
  return browserEnvironmentId !== null
}
export function canonicalTarget(target: RuntimeClientTarget): RuntimeClientTarget | null {
  if (target.kind !== 'local' || !isWebClientLocation()) {
    return target
  }
  return browserEnvironmentId ? { kind: 'environment', environmentId: browserEnvironmentId } : null
}
export const targetKey = (target: RuntimeClientTarget) =>
  target.kind === 'local' ? 'local' : `environment:${target.environmentId}`

export function snapshot(target: RuntimeClientTarget, state: AppState) {
  const ids = new Set<string>()
  if (state.activeWorktreeId) {
    ids.add(state.activeWorktreeId)
  }
  const mounted = mountedWorkspaceIds()
  if (!mounted) {
    return { complete: false, workspaceIds: [] }
  }
  for (const id of mounted) {
    ids.add(id)
  }
  let complete = true
  const workspaceIds: string[] = []
  for (const id of ids) {
    const resolved = tryRuntimeTargetForWorktreeOwner(
      state,
      id,
      id === state.activeWorktreeId
        ? (state.activeWorkspaceExecutionHostId ?? undefined)
        : undefined
    )
    const owner = resolved && canonicalTarget(resolved)
    if (!owner) {
      complete = false
      continue
    }
    if (targetKey(owner) === targetKey(target)) {
      workspaceIds.push(id)
    }
  }
  return { complete: complete && workspaceIds.length <= 64, workspaceIds }
}

export function registerMountedWorkspaceReader(read: () => ReadonlySet<string>): () => void {
  mountedReaders.add(read)
  return () => {
    mountedReaders.delete(read)
  }
}
export function mountedWorkspaceIds(): Set<string> | null {
  const ids = new Set<string>()
  try {
    for (const read of mountedReaders) {
      for (const id of read()) {
        ids.add(id)
      }
    }
    return ids
  } catch {
    return null
  }
}
