import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import {
  structuredWorkItemComposerPreflightUnavailableMessage,
  structuredWorkItemComposerEmptyPromptMessage
} from '@/lib/launch-work-item-direct-messages'
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
  /** Decided by the planner, the only module allowed to resolve a route. */
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
    // A runtime that does not answer cannot admit a scoped create. Failing here is a closed
    // refusal (capabilities stay unknown and support refuses), never an exception that climbs a
    // path the caller treats as a decision.
    try {
      await refreshLocalRuntimeCapabilities()
    } catch {
      // Leaves capabilities unknown; the resolver below refuses.
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
 * A quick create's route, with the strict refusal resolved BEFORE any workspace exists.
 *
 * Throws when a strict Start is unsupported: after the create, a block would leave the workspace
 * alive with no writer, the exact signature this Start removes.
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
  quickPrompt: string
  draftPrompt: string | null
  workspaceExecutionHostId: string | undefined
  initialSessionOptions?: Readonly<Record<string, unknown>>
}): Promise<{ route: AgentLaunchRoute; promptDelivery: QuickCreationPromptDelivery }> {
  const promptDelivery = resolveQuickCreationPromptDelivery(
    args.workItemPromptDelivery,
    args.draftPrompt
  )
  // The verdict travels in the request as data and is re-entered once the worktree exists.
  const plannedRoute = args.agent
    ? planAgentSessionLaunch(useAppStore.getState(), {
        agent: args.agent,
        workspace: {
          kind: args.workspaceKind,
          repoId: args.repoId,
          executionHostId: args.workspaceExecutionHostId
        },
        prompt: args.draftPrompt ?? args.quickPrompt,
        promptDelivery,
        initialSessionOptions: args.initialSessionOptions
      }).route
    : 'terminal-tui'
  if (args.workItemPromptDelivery !== 'submit-after-ready') {
    return { route: plannedRoute, promptDelivery }
  }
  const resolution = await prepareQuickWorkItemStartRoute({
    agent: args.agent,
    hasLinkedWorkItem: true,
    settings: args.settings,
    // The host the workspace will run on (ephemeral VM, run target), not the source repo's: a local
    // repo creating on another host must be refused before any worktree exists.
    executionHostId: args.workspaceExecutionHostId ?? args.executionHostId,
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
  // After the route check, so an unsupported agent keeps its own refusal; still before create.
  refuseStrictStartWithoutPrompt(args.workItemPromptDelivery, args.quickPrompt)
  return { route: resolution.route, promptDelivery }
}

/** An ephemeral VM is never a local execution host, so a strict Start on one is refused before
 *  anything is provisioned; the route check re-proves the host for every other target. */
export function refuseStrictStartOnEphemeralVm(
  workItemPromptDelivery: WorkItemStartPromptDelivery | undefined
): void {
  if (workItemPromptDelivery === 'submit-after-ready') {
    throw new Error(structuredWorkItemComposerPreflightUnavailableMessage())
  }
}

export type QuickCreationPromptDelivery = 'draft' | 'auto-submit' | 'submit-after-ready'

/** A strict Start delivers only after readiness under its scoped origin; `auto-submit` would miss
 *  the strict guard and let a refused send requeue into the legacy outbox. */
function resolveQuickCreationPromptDelivery(
  workItemPromptDelivery: WorkItemStartPromptDelivery | undefined,
  draftPrompt: string | null
): QuickCreationPromptDelivery {
  if (workItemPromptDelivery === 'submit-after-ready') {
    return 'submit-after-ready'
  }
  return draftPrompt ? 'draft' : 'auto-submit'
}

/** A strict Start with nothing to submit has no delivery to prove, so it is refused before any
 *  workspace exists instead of completing (or reconciling) on an empty send. */
function refuseStrictStartWithoutPrompt(
  workItemPromptDelivery: WorkItemStartPromptDelivery | undefined,
  prompt: string
): void {
  if (workItemPromptDelivery === 'submit-after-ready' && !prompt.trim()) {
    throw new Error(structuredWorkItemComposerEmptyPromptMessage())
  }
}
