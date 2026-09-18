import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import { splitWorktreeId, worktreeIdsEqual } from '../../shared/worktree/id'
import { normalizeLocalBranchName } from './runtime-worktree-selection'

export type ResolvedWorktree = Worktree & {
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: WorktreeLineage | null
  git: GitWorktreeInfo
}

export function branchSelectorMatches(branch: string, selector: string): boolean {
  // Why: Git can report a local branch as `refs/heads/foo` or `foo` depending on the plumbing path; accept either.
  return normalizeLocalBranchName(branch) === normalizeLocalBranchName(selector)
}

export function runtimePathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/** Runtime-side name for the shared workspace-identity comparison; see `worktreeIdsEqual`. */
export const runtimeWorktreeIdsEqual = worktreeIdsEqual

export function runtimeWorktreeIdentityKey(worktreeId: string): string {
  // Same suffix rule: this keys PTY refresh, sleep, and mutation-queue state per session.
  const parsed = splitWorktreeId(worktreeId)
  return parsed
    ? `${parsed.repoId}\0${normalizeRuntimePathForComparison(parsed.worktreePath)}`
    : worktreeId
}

/**
 * Keys the workspace lifecycle hold per execution host. One worktree id can name two records
 * on two hosts (a local row and an `ssh:*` row under the migrated spelling), and upstream runs
 * their removals concurrently: a hold on one host must neither wait for nor block a create or
 * a removal on the other. No host means the local machine, which is what an unscoped hold has
 * always meant.
 */
export function runtimeWorktreeLifecycleKey(
  worktreeId: string,
  executionHostId?: string | null
): string {
  const host = parseExecutionHostId(executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
  return `${host}\0${runtimeWorktreeIdentityKey(worktreeId)}`
}

export function runtimeWorktreeLookupKey(worktreeId: string): string {
  const parsed = splitWorktreeId(worktreeId)
  return JSON.stringify(
    parsed
      ? ['parsed', parsed.repoId, normalizeRuntimePathForComparison(parsed.worktreePath)]
      : ['raw', worktreeId]
  )
}

export function createIncrementalResolvedWorktreeLookup(
  resolvedWorktrees: ResolvedWorktree[]
): (worktreeId: string) => ResolvedWorktree | undefined {
  const worktreeByIdentity = new Map<string, ResolvedWorktree>()
  let indexedCount = 0
  return (worktreeId) => {
    const lookupKey = runtimeWorktreeLookupKey(worktreeId)
    const indexed = worktreeByIdentity.get(lookupKey)
    if (indexed) {
      return indexed
    }
    while (indexedCount < resolvedWorktrees.length) {
      const worktree = resolvedWorktrees[indexedCount]
      indexedCount += 1
      const key = runtimeWorktreeLookupKey(worktree.id)
      // Why: preserve Array.find's first match when normalized identities collide.
      if (!worktreeByIdentity.has(key)) {
        worktreeByIdentity.set(key, worktree)
      }
      if (key === lookupKey) {
        return worktreeByIdentity.get(key)
      }
    }
    return undefined
  }
}

export function resolveTerminalSessionWorktreeId(
  session: WorkspaceSessionState,
  targetWorktreeId: string
): string | null {
  const keyedWorktreeIds = new Set([
    ...Object.keys(session.tabsByWorktree),
    ...Object.keys(session.tabGroups ?? {}),
    ...Object.keys(session.tabGroupLayouts ?? {}),
    ...Object.keys(session.activeTabIdByWorktree ?? {}),
    ...Object.keys(session.activeGroupIdByWorktree ?? {})
  ])
  const matches = [...keyedWorktreeIds].filter((worktreeId) =>
    runtimeWorktreeIdsEqual(worktreeId, targetWorktreeId)
  )
  return matches.length > 1 ? null : (matches[0] ?? targetWorktreeId)
}

export function inferWorktreeIdFromPtyId(ptyId: string): string | null {
  return parsePtySessionId(ptyId).worktreeId
}

export function parseRuntimeWorktreeId(
  worktreeId: string
): { repoId: string; worktreePath: string } | null {
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId) {
    return null
  }
  if (!parsed.worktreePath) {
    return null
  }
  return parsed
}

export function includeTargetResolvedWorktree(
  resolvedWorktrees: ResolvedWorktree[],
  targetWorktree: ResolvedWorktree | null
): ResolvedWorktree[] {
  if (!targetWorktree || resolvedWorktrees.some((worktree) => worktree.id === targetWorktree.id)) {
    return resolvedWorktrees
  }
  return [...resolvedWorktrees, targetWorktree]
}

export function findResolvedWorktreeIdForPath(
  resolvedWorktrees: ResolvedWorktree[],
  cwd: string,
  targetWorktreeId?: string | null
): string | null {
  if (!cwd) {
    return null
  }
  const matches = resolvedWorktrees
    .filter((worktree) => isPathInsideOrEqual(worktree.path, cwd))
    .sort((left, right) => right.path.length - left.path.length)
  // Why: a cwd cannot distinguish folder-workspace siblings, which all share one
  // directory. Break that tie toward the caller's target instead of store order,
  // so an unattributed PTY still lands in the workspace being listed. Only ties at
  // the deepest path qualify — a nested worktree must still beat its parent.
  const deepest = matches.filter((worktree) => worktree.path.length === matches[0]?.path.length)
  return (
    (deepest.length > 1
      ? deepest.find((worktree) => worktree.id === targetWorktreeId)?.id
      : undefined) ??
    matches[0]?.id ??
    null
  )
}
