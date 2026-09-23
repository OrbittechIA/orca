import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  readClaudeManagedAccountGateSettings,
  structuredClaudeMatchesActiveManagedAccount,
  type ClaudeManagedAccountGateSettings
} from './claude-structured-managed-account-support'

export type StructuredAgentSessionCreateSupport = {
  supported: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

/**
 * The create-support verdict, kept out of the runtime class file because that file is `@ts-nocheck`
 * — a call site there is not typechecked, so an auth-identity decision written inline would compile
 * however wrong it was. The runtime hands over the two facts it owns and this decides.
 */
export function resolveStructuredAgentSessionCreateSupport(input: {
  agent: 'claude' | 'codex'
  location: AgentSessionExecutionLocation
  adapterSupportsCreate: boolean
  getSettings: () => ClaudeManagedAccountGateSettings
}): StructuredAgentSessionCreateSupport {
  if (!input.adapterSupportsCreate) {
    return {
      supported: false,
      reason:
        input.location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : input.location.wslDistro
            ? 'wsl'
            : 'agent'
    }
  }
  // Claude only: Codex resolves its account on a different path, so its answer is untouched here.
  // `wsl` is the closest existing reason — the cause is a WSL-bound account rather than a WSL
  // workspace — so mobile's pre-create WSL refusal copy can misname this case.
  if (
    input.agent === 'claude' &&
    !structuredClaudeMatchesActiveManagedAccount(
      readClaudeManagedAccountGateSettings(input.getSettings)
    )
  ) {
    return { supported: false, reason: 'wsl' }
  }
  return { supported: true }
}

/**
 * Where a strict Work Item Start's workspace WOULD run, read from its source repo so the verdict
 * lands before `worktree.create`. `configuredWslDistro` is the project-runtime authority the
 * post-create location reads; a WSL UNC repo path counts too, as it does for desktop's pre-create.
 */
export function workItemStartPreCreateLocation(input: {
  repo: Repo
  configuredWslDistro: () => string | null
}): AgentSessionExecutionLocation {
  const executionHostId = getRepoExecutionHostId(input.repo)
  const wslDistro =
    executionHostId === LOCAL_EXECUTION_HOST_ID
      ? (input.configuredWslDistro() ?? parseWslUncPath(input.repo.path)?.distro ?? null)
      : null
  return {
    executionHostId,
    wslDistro,
    // No workspace exists yet; the verdict reads only the host and runtime above.
    workspaceId: input.repo.id,
    workspaceKind: isFolderRepo(input.repo) ? 'folder' : 'git-worktree'
  }
}
