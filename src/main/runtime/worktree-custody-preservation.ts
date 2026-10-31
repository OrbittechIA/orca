import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExecFileAsync } from '../git/runner'

const GIT_TIMEOUT_MS = 5_000
// Per-worktree Git state that unforced removal discards with the admin directory.
const IN_PROGRESS_STATE = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
  'rebase-merge',
  'rebase-apply',
  'sequencer'
]

export type WorktreePreservation =
  | { preserved: true; proof: string }
  | { preserved: false; reason: string }

type GitRead = (args: string[], cwd: string) => Promise<string>

const readGit: GitRead = async (args, cwd) =>
  (await gitExecFileAsync(args, { cwd, timeout: GIT_TIMEOUT_MS })).stdout

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * Positive Git-owned proof that removing the checkout loses no unique material: every entry is a
 * tracked file identical to HEAD, HEAD is a shared branch the fixed effect retains, and no ignored,
 * untracked, hidden-index, gitlink or per-worktree ref/state exists. Any doubt is a refusal.
 */
export async function proveWorktreePreservation(
  path: string,
  git: GitRead = readGit
): Promise<WorktreePreservation> {
  try {
    if ((await git(['rev-parse', '--show-toplevel'], path)).trim() !== path) {
      return { preserved: false, reason: 'git_toplevel_mismatch' }
    }
    const status = await git(
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none'
      ],
      path
    )
    if (status.length > 0) {
      return { preserved: false, reason: 'tracked_untracked_or_ignored_material' }
    }
    // Only plain cached entries: assume-unchanged/skip-worktree edits are invisible to status.
    const tags = (await git(['ls-files', '-v', '-z'], path)).split('\0').filter(Boolean)
    const stages = (await git(['ls-files', '--stage', '-z'], path)).split('\0').filter(Boolean)
    if (
      tags.some((entry) => !entry.startsWith('H ')) ||
      stages.some((entry) => entry.startsWith('160000 '))
    ) {
      return { preserved: false, reason: 'hidden_index_or_gitlink_material' }
    }
    const branch = (await git(['symbolic-ref', '-q', 'HEAD'], path)).trim()
    if (!branch.startsWith('refs/heads/')) {
      return { preserved: false, reason: 'detached_head_unretained' }
    }
    const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'], path)).trim()
    const tip = (await git(['rev-parse', '--verify', `${branch}^{commit}`], path)).trim()
    if (!/^[0-9a-f]{40,64}$/.test(head) || head !== tip) {
      return { preserved: false, reason: 'branch_tip_unbound' }
    }
    const local = await git(
      ['for-each-ref', '--format=%(refname)', 'refs/worktree', 'refs/bisect', 'refs/rewritten'],
      path
    )
    if (local.trim()) {
      return { preserved: false, reason: 'per_worktree_refs' }
    }
    const gitDir = (await git(['rev-parse', '--absolute-git-dir'], path)).trim()
    for (const name of IN_PROGRESS_STATE) {
      if (await present(join(gitDir, name))) {
        return { preserved: false, reason: 'operation_in_progress' }
      }
    }
    return { preserved: true, proof: `git-preservation:${branch}@${head}` }
  } catch {
    return { preserved: false, reason: 'git_preservation_unavailable' }
  }
}
