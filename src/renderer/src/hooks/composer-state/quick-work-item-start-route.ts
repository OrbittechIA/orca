import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { structuredWorkItemComposerPreflightUnavailableMessage } from '@/lib/launch-work-item-direct-messages'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorkItemStartPromptDelivery } from '../../../../shared/agent-session-options'
import { resolveWorkItemStartPromptDelivery } from '../../../../shared/agent-session-options'
import {
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatBlocker
} from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  hasExplicitTuiLaunchCommand,
  type AgentLaunchRoute,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  refreshLocalRuntimeCapabilities
} from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'

type QuickWorkItemStartRouteInput = Omit<AgentLaunchRoutingInput, 'agent' | 'promptDelivery'> & {
  agent: TuiAgent | null
  hasLinkedWorkItem: boolean
  settings: GlobalSettings | null | undefined
  hasDraftPrompt: boolean
  /** Decidida pelo planner — o único módulo autorizado a resolver rota. */
  ordinaryRoute: AgentLaunchRoute
}

export type QuickWorkItemStartRouteResolution =
  | {
      ok: true
      route: AgentLaunchRoute
      workItemPromptDelivery?: WorkItemStartPromptDelivery
    }
  | {
      ok: false
      blocker: StructuredNativeChatBlocker
      workItemPromptDelivery: 'submit-after-ready'
    }

export function resolveQuickWorkItemStartRoute(
  input: QuickWorkItemStartRouteInput
): QuickWorkItemStartRouteResolution {
  const workItemPromptDelivery = input.hasLinkedWorkItem
    ? resolveWorkItemStartPromptDelivery(input.settings?.workItemStartPromptDelivery)
    : undefined
  if (workItemPromptDelivery === 'submit-after-ready') {
    const support = input.agent
      ? resolveStructuredNativeChatSupport({
          agent: input.agent,
          executionHostId: input.executionHostId,
          hostCapabilities: input.hostCapabilities,
          workspaceKind: input.workspaceKind,
          projectRuntime: input.projectRuntime,
          requiresTuiLaunchCommand: input.requiresTuiLaunchCommand,
          launchOrigin: 'work-item-start'
        })
      : ({ supported: false, blocker: 'agent-without-structured-session' } as const)
    return support.supported
      ? { ok: true, route: 'structured-native-chat', workItemPromptDelivery }
      : { ok: false, blocker: support.blocker, workItemPromptDelivery }
  }

  return {
    ok: true,
    route: input.agent ? input.ordinaryRoute : 'terminal-tui',
    ...(workItemPromptDelivery ? { workItemPromptDelivery } : {})
  }
}

export async function prepareQuickWorkItemStartRoute(args: {
  agent: TuiAgent | null
  hasLinkedWorkItem: boolean
  settings: GlobalSettings | null | undefined
  executionHostId: string
  repoId: string
  workspaceKind: 'git-worktree' | 'folder'
  hasDraftPrompt: boolean
  launchText: string
  nativeChatTranscriptIsLocalReadable: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
  requiresTuiLaunchCommand?: boolean
  ordinaryRoute: AgentLaunchRoute
}): Promise<QuickWorkItemStartRouteResolution> {
  const delivery = args.hasLinkedWorkItem
    ? resolveWorkItemStartPromptDelivery(args.settings?.workItemStartPromptDelivery)
    : undefined
  if (
    delivery === 'submit-after-ready' &&
    args.executionHostId === 'local' &&
    readLocalRuntimeCapabilitiesOrUnknown() === null
  ) {
    // Um runtime que não responde não pode admitir um create escopado. Falhar aqui é
    // recusa fechada — as capabilities seguem desconhecidas e o suporte recusa —, nunca
    // uma exceção que sobe por um caminho que o chamador trata como decisão.
    try {
      await refreshLocalRuntimeCapabilities()
    } catch {
      // deixa as capabilities desconhecidas; o resolvedor abaixo recusa
    }
  }
  return resolveQuickWorkItemStartRoute({
    ...args,
    hostCapabilities: readLocalRuntimeCapabilitiesOrUnknown(),
    // Runtime policy follows the renderer host, not the WSL launch platform.
    projectRuntime: getLocalRepoProjectExecutionRuntimeContext(useAppStore.getState(), args.repoId),
    requiresTuiLaunchCommand:
      args.requiresTuiLaunchCommand === true ||
      (args.agent !== null && hasExplicitTuiLaunchCommand(args.settings, args.agent))
  })
}

/**
 * A rota de um quick create, com a recusa estrita resolvida ANTES de existir workspace.
 *
 * Lança quando um Start estrito não tem suporte: depois do create, um bloqueio deixaria a
 * workspace viva sem writer nenhum — a assinatura exata que este Start remove.
 */
export async function resolveQuickCreationAgentLaunchRoute(args: {
  agent: TuiAgent | null
  workItemPromptDelivery: WorkItemStartPromptDelivery | undefined
  settings: GlobalSettings | null | undefined
  executionHostId: string
  repoId: string
  workspaceKind: 'git-worktree' | 'folder'
  launchText: string
  nativeChatTranscriptIsLocalReadable: boolean
  prompt: string
  promptDelivery: 'draft' | 'auto-submit'
  workspaceExecutionHostId: string | undefined
  initialSessionOptions?: Readonly<Record<string, unknown>>
}): Promise<AgentLaunchRoute> {
  // O verdito viaja no pedido como dado e é re-entrado quando a worktree existir.
  const plannedRoute = args.agent
    ? planAgentSessionLaunch(useAppStore.getState(), {
        agent: args.agent,
        workspace: {
          kind: args.workspaceKind,
          repoId: args.repoId,
          executionHostId: args.workspaceExecutionHostId
        },
        prompt: args.prompt,
        promptDelivery: args.promptDelivery,
        initialSessionOptions: args.initialSessionOptions
      }).route
    : 'terminal-tui'
  if (args.workItemPromptDelivery !== 'submit-after-ready') {
    return plannedRoute
  }
  const resolution = await prepareQuickWorkItemStartRoute({
    agent: args.agent,
    hasLinkedWorkItem: true,
    settings: args.settings,
    executionHostId: args.executionHostId,
    repoId: args.repoId,
    workspaceKind: args.workspaceKind,
    hasDraftPrompt: false,
    launchText: args.launchText,
    nativeChatTranscriptIsLocalReadable: args.nativeChatTranscriptIsLocalReadable,
    ordinaryRoute: plannedRoute
  })
  if (!resolution.ok) {
    throw new Error(structuredWorkItemComposerPreflightUnavailableMessage())
  }
  return resolution.route
}
