import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  resolveWorkItemStartPromptDelivery,
  type WorkItemStartPromptDelivery
} from '../../../../shared/agent-session-options'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { structuredWorkItemComposerPreflightUnavailableMessage } from '@/lib/launch-work-item-direct-messages'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import { useAppStore } from '@/store'
import { resolveFolderWorkspaceLaunchDraft } from './folder-workspace-agent-startup'

export type FolderWorkspaceWorkItemStartPlan = {
  workItemPromptDelivery: WorkItemStartPromptDelivery | undefined
  strict: boolean
  launchDraftPrompt: string | null
  plan: AgentSessionLaunchPlan | null
}

/**
 * A entrega, o rascunho e a rota de um create de pasta — decididos ANTES do create.
 *
 * Lança quando um Start estrito não alcança a rota estruturada: um bloqueio resolvido
 * depois deixaria a workspace de pasta criada sem writer nenhum.
 */
export function planFolderWorkspaceWorkItemStart(args: {
  projectGroup: ProjectGroup
  linkedWorkItem: LinkedWorkItemSummary | null
  note: string
  quickAgent: TuiAgent | null
  agentArgs?: string | null
  settings?: GlobalSettings | null
  runtimeEnvironmentId?: string | null
  initialSessionOptions?: Readonly<Record<string, unknown>>
}): FolderWorkspaceWorkItemStartPlan {
  const workItemPromptDelivery = args.linkedWorkItem
    ? resolveWorkItemStartPromptDelivery(args.settings?.workItemStartPromptDelivery)
    : undefined
  const strict = workItemPromptDelivery === 'submit-after-ready'
  const launchDraftPrompt =
    args.quickAgent && args.linkedWorkItem
      ? resolveFolderWorkspaceLaunchDraft(args.linkedWorkItem, args.note, workItemPromptDelivery)
      : null
  const plan = args.quickAgent
    ? planAgentSessionLaunch(useAppStore.getState(), {
        agent: args.quickAgent,
        workspace: {
          kind: 'folder',
          runtimeEnvironmentId: args.runtimeEnvironmentId,
          // Um caminho UNC de WSL executa no WSL: o Start estrito precisa ver esse host
          // para recusar, e não o `local` que o grupo de projeto reporta.
          executionHostId:
            strict && isWslUncPath(args.projectGroup.parentPath ?? '')
              ? 'wsl:local'
              : getNewWorkspaceProjectGroupHostId(args.projectGroup)
        },
        prompt: launchDraftPrompt ?? args.note,
        promptDelivery: strict ? 'submit-after-ready' : launchDraftPrompt ? 'draft' : 'auto-submit',
        tuiCustomization: { agentArgs: args.agentArgs },
        initialSessionOptions: args.initialSessionOptions,
        ...(strict ? { launchOrigin: 'work-item-start' as const } : {})
      })
    : null
  if (strict && plan?.route !== 'structured-native-chat') {
    throw new Error(structuredWorkItemComposerPreflightUnavailableMessage())
  }
  return { workItemPromptDelivery, strict, launchDraftPrompt, plan }
}
