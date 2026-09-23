import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import { parseWslUncPath } from './wsl-paths'

/**
 * Why a strict Work Item Start cannot run for this repo on the host, decided from the repo row
 * alone so a paired client can refuse BEFORE `worktree.create`. The host's structured support
 * refuses the same two cases (`remote`, `wsl`), but only after the workspace already exists.
 */
export function workItemStartExecutionHostRefusal(repo: {
  path: string
  connectionId?: string | null
  executionHostId?: string | null
}): 'remote' | 'wsl' | null {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return 'remote'
  }
  return parseWslUncPath(repo.path) ? 'wsl' : null
}
