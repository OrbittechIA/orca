import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

/** What `resolveRuntimeFileTarget` answers, for both git worktrees and folder workspaces. */
export type RuntimeFileTarget = {
  worktree: ResolvedWorktree
  executionHostId: ExecutionHostId
}

/**
 * Where a structured agent session would execute for a resolved target.
 *
 * Kept out of the runtime class because it is a pure projection of the target and the
 * configured WSL distro — nothing here needs the runtime, and the class it came from was over
 * its line budget.
 */
export function structuredAgentSessionExecutionLocation(args: {
  target: RuntimeFileTarget
  configuredWslDistro: string | null
}): AgentSessionExecutionLocation {
  const { target } = args
  const folderScope = parseWorkspaceKey(target.worktree.id)
  const folderWorkspace = folderScope?.type === 'folder'
  const isLocalHost = target.executionHostId === LOCAL_EXECUTION_HOST_ID
  // Folder workspaces have no repo Git options, so a WSL UNC path is the only
  // durable signal that native Windows structured Codex cannot safely use it.
  const wslDistro =
    args.configuredWslDistro ??
    (folderWorkspace && isLocalHost
      ? (parseWslUncPath(target.worktree.path)?.distro ?? null)
      : null)
  return {
    executionHostId: target.executionHostId,
    wslDistro,
    workspaceId: target.worktree.id,
    workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
  }
}
