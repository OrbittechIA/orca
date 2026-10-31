import { isAbsolute, normalize } from 'node:path'
import {
  getRepoExecutionHostId,
  isRepoOnCatalogHost,
  normalizeHostPart,
  parseRoutableExecutionHostId
} from '../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isWslUncPath } from '../../shared/wsl-paths'
import { resolveWorktreeRemovalRepoOwner } from '../worktree-removal-repo-owner'
import type { RuntimeStore } from './runtime-store-contract'

export type CustodySelectionLocation = { path: string; hostId: string }

export function resolveCustodySelectionLocation(
  store: Pick<RuntimeStore, 'getRepos' | 'getRepo' | 'getFolderWorkspaces'>,
  workspaceId: string
): CustodySelectionLocation | null {
  const scope = parseWorkspaceKey(workspaceId)
  const parsed = splitWorktreeIdForFilesystem(
    scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  )
  const owner = parsed?.repoId ? resolveWorktreeRemovalRepoOwner(store, parsed.repoId) : null
  const folders =
    scope?.type === 'folder'
      ? store.getFolderWorkspaces?.().filter((folder) => folder.id === scope.folderWorkspaceId)
      : undefined
  const record =
    scope?.type === 'folder'
      ? folders?.length === 1
        ? folders[0]
        : undefined
      : owner?.kind === 'resolved'
        ? owner.repo
        : undefined
  const path = scope?.type === 'folder' ? folders?.[0]?.folderPath : parsed?.worktreePath
  if (
    !record ||
    record.orcadRetained ||
    !path ||
    !isAbsolute(path) ||
    isWslUncPath(path) ||
    path.includes('\0')
  ) {
    return null
  }
  if (isRepoOnCatalogHost(record)) {
    return { path: normalize(path), hostId: 'local' }
  }
  const explicit = normalizeHostPart(record.executionHostId)
  const host = parseRoutableExecutionHostId(explicit ?? getRepoExecutionHostId(record))
  return host && host.kind !== 'local' ? { path: normalize(path), hostId: host.id } : null
}
