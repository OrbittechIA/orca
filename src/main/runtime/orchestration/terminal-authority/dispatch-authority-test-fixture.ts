import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'

/** A complete local terminal authority; partial casts hide fields dispatch reads, such as hostScope. */
export function localDispatchAuthority(
  fields: Pick<
    OrchestrationCompatibilityTerminalAuthority,
    'terminalHandle' | 'paneKey' | 'processIncarnation'
  > &
    Partial<OrchestrationCompatibilityTerminalAuthority>
): OrchestrationCompatibilityTerminalAuthority {
  return {
    runtimeId: 'runtime_test',
    ptyId: `pty_${fields.terminalHandle}`,
    worktreeId: 'repo::worktree',
    launchTokenHash: null,
    hostScope: { kind: 'local', hostId: 'local' },
    ...fields
  }
}
