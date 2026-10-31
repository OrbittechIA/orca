import type { WorkerEffect } from './worker-topology'
import type { WorkerStartInput } from './worker-start-schema'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import type { WorkerWorktreeCreationTarget } from './worker-worktree-creation'
import type { prepareLocalWorkerStart } from './worker-start-validation'
import { assertWorkerFilesystemScopeAdmissible } from '../../../../orchestration/worker-filesystem-scope'

export function localWorkerStartOptions(args: {
  params: WorkerStartInput
  mode: WorkerStartModeReceipt
  resolvedWorktreeId: string | undefined
  creationTarget: WorkerWorktreeCreationTarget | undefined
  agent: ReturnType<typeof prepareLocalWorkerStart>['agent']
  launch: ReturnType<typeof prepareLocalWorkerStart>['launch']
}) {
  const { params, mode, resolvedWorktreeId, creationTarget, agent, launch } = args
  if (params.filesystemScope) {
    // Never pin a scope this host cannot enforce; this runs before the Dispatch exists.
    assertWorkerFilesystemScopeAdmissible({ agent, mode: mode.mode })
  }
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  return {
    worktree: requestedWorktree,
    mode,
    resolvedWorktreeId: resolvedWorktreeId ?? null,
    name: params.name ?? null,
    repo: creationTarget?.repoSelector ?? params.repo ?? null,
    baseBranch: params.baseBranch ?? null,
    terminal: params.terminal ?? null,
    agent: agent ?? null,
    launch: launch.receipt,
    // The request is pinned with the Dispatch; the bound form is pinned on the session record.
    ...(params.filesystemScope ? { filesystemScope: params.filesystemScope } : {}),
    timeoutMs: params.timeoutMs ?? 60_000,
    setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
    setupSource: createsWorktree
      ? params.setup
        ? 'explicit_request'
        : 'orchestration_default'
      : 'existing_worktree'
  }
}

export function initialLocalWorkerEffects(worktree: { id: string } | undefined): WorkerEffect[] {
  return worktree
    ? [
        { kind: 'worktree', action: 'reused', id: worktree.id },
        { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
      ]
    : []
}
