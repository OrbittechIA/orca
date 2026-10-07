import { toast } from 'sonner'
import { getSetupConfig } from '@/lib/new-workspace'
import { resolvePrHeadErrorMessage } from '@/lib/launch-work-item-direct-messages'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OrcaHooks, RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { GitHubPrStartPoint } from '../../../shared/worktree/types'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'

// Why: preflight routes by the repo's owner host, which `getSettingsForRepoRuntimeOwner`
// hands back as a narrow runtime-scope pick rather than the full GlobalSettings.
type PreflightSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export async function resolveDirectPrStartPoint(
  repoId: string,
  prNumber: number,
  settings: PreflightSettings,
  hints: {
    branchName?: string
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  } = {}
): Promise<GitHubPrStartPoint> {
  return resolveGitHubPrStartPointForRepo({
    repoId,
    prNumber,
    settings,
    headRefName: hints.headRefName ?? hints.branchName,
    baseRefName: hints.baseRefName,
    isCrossRepository: hints.isCrossRepository
  })
}

/**
 * The start point a direct launch creates from. Direct "Use PR" launches bypass the Start-from
 * picker, so they must still resolve the PR head before `git worktree add`; `null` means that
 * failed and was reported.
 */
export async function resolveDirectWorkItemStartPoint(
  args: Pick<LaunchWorkItemDirectArgs, 'baseBranch' | 'item' | 'repoId'>,
  itemType: string,
  itemNumber: number | null,
  settings: PreflightSettings
): Promise<Partial<GitHubPrStartPoint> | null> {
  if (args.baseBranch || itemType !== 'pr' || !itemNumber) {
    return { baseBranch: args.baseBranch }
  }
  try {
    return await resolveDirectPrStartPoint(args.repoId, itemNumber, settings, args.item)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : resolvePrHeadErrorMessage())
    return null
  }
}

export async function resolveDirectSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings },
  settings: PreflightSettings
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    // Why: route the hooks probe by the repo's owner host (passed in) so preflight
    // and the subsequent owner-routed createWorktree hit the same host.
    const result = await checkRuntimeHooks(settings, repoId)
    yamlHooks = (result.hooks as OrcaHooks | null) ?? null
  } catch {
    yamlHooks = null
  }
  const setupConfig = getSetupConfig(repo, yamlHooks)
  if (!setupConfig) {
    // Why: no setup script configured, so this path should behave like callers
    // that omit a setup decision entirely.
    return { kind: 'decided', decision: 'inherit' }
  }
  const policy = repo.hookSettings?.setupRunPolicy ?? 'run-by-default'
  if (policy === 'ask') {
    return { kind: 'needs-modal' }
  }
  return {
    kind: 'decided',
    decision: policy === 'run-by-default' ? 'run' : 'skip'
  }
}
