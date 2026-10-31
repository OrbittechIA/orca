import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import {
  normalizeFilesystemScopeRoot,
  ORCHESTRATION_FILESYSTEM_SCOPE_VERSION,
  type BoundOrchestrationFilesystemScope,
  type OrchestrationFilesystemScopeRequest
} from '../../../shared/orchestration-filesystem-scope'
import { OrchestrationError } from './orchestration-error'

/** Codex's workspace sandbox needs Seatbelt or bubblewrap; Orca does not project Windows sandboxes. */
export function hostSupportsWorkerFilesystemScope(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'linux' || platform === 'darwin'
}

function refuse(reason: string, message: string): never {
  throw new OrchestrationError('filesystem_scope_refused', message, { reason })
}

/** Refuse before any Dispatch, worktree or session effect. */
export function assertWorkerFilesystemScopeAdmissible(args: {
  agent: string | undefined
  mode: 'structured' | 'terminal'
  platform?: NodeJS.Platform
}): void {
  if (!hostSupportsWorkerFilesystemScope(args.platform)) {
    refuse(
      'host_unsupported',
      `Filesystem scope is not enforced on ${args.platform ?? process.platform}.`
    )
  }
  if (args.agent !== 'codex') {
    refuse(
      'provider_unsupported',
      `Filesystem scope is enforced only for codex structured workers, not ${args.agent ?? 'an unresolved agent'}.`
    )
  }
  if (args.mode !== 'structured') {
    refuse(
      'terminal_unsupported',
      'Filesystem scope needs a structured chat worker; terminal workers have no provider sandbox binding.'
    )
  }
}

/** An exact realpath match rules out symlinked components anywhere between the worktree and the root. */
export async function bindWorkerFilesystemScope(args: {
  request: OrchestrationFilesystemScopeRequest
  worktreePath: string | undefined
  taskId: string | undefined
  dispatchId: string
}): Promise<BoundOrchestrationFilesystemScope> {
  const { request, taskId } = args
  if (!taskId) {
    refuse('task_unbound', "Filesystem scope must bind to the Dispatch's Task.")
  }
  if (!args.worktreePath || !isAbsolute(args.worktreePath)) {
    refuse('worktree_unresolved', 'Filesystem scope needs the worker worktree path on this host.')
  }
  const lexicalWorktree = normalize(args.worktreePath).replace(/\/+$/, '') || '/'
  const worktreePath = await realpath(lexicalWorktree).catch(() =>
    refuse('worktree_unresolved', `Worker worktree ${lexicalWorktree} is not readable.`)
  )
  if (worktreePath !== lexicalWorktree) {
    refuse(
      'symlink',
      `Worker worktree ${lexicalWorktree} resolves through a symlink to ${worktreePath}.`
    )
  }
  const base = {
    version: ORCHESTRATION_FILESYSTEM_SCOPE_VERSION,
    worktreePath,
    taskId,
    dispatchId: args.dispatchId,
    provider: 'codex' as const
  }
  if (request.kind === 'read-only') {
    return { ...base, kind: 'read-only', roots: [], cwd: worktreePath }
  }
  const roots: string[] = []
  for (const requested of request.roots) {
    const relative = normalizeFilesystemScopeRoot(requested)
    const lexical = relative === '.' ? worktreePath : join(worktreePath, relative)
    const resolved = await realpath(lexical).catch(() =>
      refuse(
        'root_missing',
        `Scope root ${JSON.stringify(requested)} does not exist in the worktree.`
      )
    )
    if (resolved !== lexical) {
      refuse(
        'symlink',
        `Scope root ${JSON.stringify(requested)} resolves through a symlink to ${resolved}.`
      )
    }
    if (!(await stat(resolved)).isDirectory()) {
      refuse('root_not_directory', `Scope root ${JSON.stringify(requested)} is not a directory.`)
    }
    roots.push(resolved)
  }
  await assertGitMetadataOutsideRoots(worktreePath, roots)
  return { ...base, kind: 'directory-roots', roots, cwd: roots[0] }
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/** Codex marks a root's top-level .git read-only, but Orca does not rely on it: no root may hold Git metadata. */
async function assertGitMetadataOutsideRoots(worktreePath: string, roots: string[]): Promise<void> {
  for (const root of roots) {
    const entry = await lstat(join(root, '.git')).catch(() => null)
    if (entry && !entry.isFile()) {
      refuse('git_metadata', `Scope root ${root} contains Git metadata (.git).`)
    }
  }
  const pointer = await readFile(join(worktreePath, '.git'), 'utf8').catch(() => null)
  const gitdir = pointer?.match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
  if (!gitdir) {
    return
  }
  const resolved = await realpath(resolve(worktreePath, gitdir)).catch(() => null)
  if (resolved && roots.some((root) => within(root, resolved) || within(resolved, root))) {
    refuse('git_metadata', `Scope roots overlap the worktree's Git directory ${resolved}.`)
  }
}
