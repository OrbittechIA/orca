import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
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
  getSettings: () => ClaudeManagedAccountGateSettings &
    Partial<Pick<GlobalSettings, 'agentCmdOverrides'>>
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
  // This host's own launch command override names a process only a terminal runs, whichever
  // client asked; a client routes on its own override for its own machine only.
  if (hasExplicitTuiLaunchCommand(readSettingsOrNull(input.getSettings), input.agent)) {
    return { supported: false, reason: 'agent' }
  }
  // Claude only: Codex resolves its account on a different path, so its answer is untouched here.
  // `agent`, never `wsl`: the workspace may be native; it is the selected agent's account that is
  // ineligible, and every client already maps `agent` without a wire change.
  if (
    input.agent === 'claude' &&
    !structuredClaudeMatchesActiveManagedAccount(
      readClaudeManagedAccountGateSettings(input.getSettings)
    )
  ) {
    return { supported: false, reason: 'agent' }
  }
  return { supported: true }
}

function readSettingsOrNull<T>(getSettings: () => T): T | null {
  try {
    return getSettings()
  } catch {
    return null
  }
}

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
