import type { GlobalSettings } from '../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { prepareQuickWorkItemStartRoute } from '@/hooks/composer-state/quick-work-item-start-route'
import { hasExplicitTuiAgentArgs } from '@/lib/agent-launch-routing'

/**
 * Whether a strict Work Item Start can take the structured route, decided BEFORE
 * `git worktree add`.
 *
 * It used to be decided after, and a blocker then toasted and returned with the workspace
 * already created, its tabs suppressed and its startup options dropped — a live bare shell
 * and `agents: []`, which is the incident signature this work exists to remove. Every input
 * is knowable beforehand: the repo's execution host and project runtime, the agent, explicit
 * TUI customization, and the capability cache.
 *
 * An unavailable agent is deliberately NOT a blocker here. That case has its own behaviour —
 * create, reveal, and say the selected agent is not available in the workspace — and
 * refusing it here would replace a usable workspace and a specific message with neither.
 */
export async function workItemStartPrecreatePreflightBlocks(args: {
  agent: TuiAgent | null
  agentUnavailable: boolean
  agentArgs?: string | null
  draftContent?: string
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
  repoConnectionId: string | null
  repoId: string
  settings: GlobalSettings | null | undefined
}): Promise<boolean> {
  if (args.agentUnavailable) {
    return false
  }
  const resolution = await prepareQuickWorkItemStartRoute({
    agent: args.agent,
    hasLinkedWorkItem: true,
    // The resolved delivery, not the stored one. The caller has already decided this is a
    // strict Start, and letting the preflight re-derive it from settings would let the two
    // disagree — which is how the check silently did nothing.
    settings: args.settings
      ? { ...args.settings, workItemStartPromptDelivery: 'submit-after-ready' as const }
      : null,
    executionHostId: args.repo ? getRepoExecutionHostId(args.repo) : LOCAL_EXECUTION_HOST_ID,
    repoId: args.repoId,
    workspaceKind: 'git-worktree',
    hasDraftPrompt: false,
    launchText: args.draftContent ?? '',
    // Start estrito: a entrega é forçada a `submit-after-ready`, logo o ramo comum
    // nunca é alcançado e esta rota nunca escapa.
    ordinaryRoute: 'terminal-tui',
    nativeChatTranscriptIsLocalReadable: args.repoConnectionId === null,
    ...(args.agentArgs !== undefined && args.agent
      ? { requiresTuiLaunchCustomization: hasExplicitTuiAgentArgs(args.agent, args.agentArgs) }
      : {})
  })
  return !resolution.ok
}

/**
 * O bloqueio estrito, decidido ANTES do `git worktree add`.
 *
 * Mora aqui e não no launcher porque um bloqueio resolvido depois do create deixava uma
 * workspace sem writer nenhum — a assinatura exata que este trabalho remove.
 */
export async function workItemStartStrictPreflightBlocks(args: {
  agentOverride?: TuiAgent | undefined
  agentArgs?: string | null | undefined
  draftContent?: string | undefined
  detectedAgentsPromise: Promise<unknown> | null
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
  repoConnectionId: string | null
  repoId: string
  settings: GlobalSettings | null | undefined
}): Promise<boolean> {
  const { resolveDirectWorkItemAgent } = await import('@/lib/launch-work-item-direct-agent-routing')
  const { useAppStore } = await import('@/store')
  const preflightAgent = await resolveDirectWorkItemAgent({
    ...(args.agentOverride !== undefined ? { agentOverride: args.agentOverride } : {}),
    launchConnectionId: args.repoConnectionId,
    repoConnectionId: args.repoConnectionId,
    detectedAgentsPromise: args.detectedAgentsPromise as never,
    latestStore: useAppStore.getState()
  })
  return workItemStartPrecreatePreflightBlocks({
    agent: preflightAgent.agent,
    agentUnavailable: preflightAgent.unavailable,
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.draftContent !== undefined ? { draftContent: args.draftContent } : {}),
    repo: args.repo,
    repoConnectionId: args.repoConnectionId,
    repoId: args.repoId,
    settings: args.settings
  })
}
