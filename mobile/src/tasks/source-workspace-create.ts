import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { resolveComposerMrBase, resolveComposerPrBase } from './composer-source-base-resolve'
import type {
  MobileComposerCreateSelection,
  MobileLinkedWorkItem
} from './mobile-composer-source-types'
import { resolveMobileWorkspaceCreateName } from './mobile-workspace-name'
import type { WorkspaceAgentChoice } from './workspace-agent-selection'
import {
  startupAgentCreateFields,
  buildTaskWorkspaceCreateParams,
  type WorkspaceCreateParams,
  type WorkspaceCreateSetupDecision,
  type WorkspaceCreateTaskItem
} from './workspace-create-params'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from './agent-launch-worktree-create'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'
import {
  startWorkItemStructuredSession,
  resolveWorkItemStartRoute,
  workItemStartAgentSupportsStructuredSession
} from './work-item-start-structured-session'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'

// The agent bundle the modal resolved: `choice` drives launch resolution — the
// host applies the agent's launch args (permission flags) and shell quoting.
export type WorkspaceCreateAgentBundle = {
  choice: WorkspaceAgentChoice
}

export type CreateWorkspaceFromComposerArgs = {
  client: RpcClient
  selection: MobileComposerCreateSelection
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  /** Whether the host can settle the surface itself; false keeps the agent-first create. */
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
  /** Only the work-item selection reads it; a branch Start has no work item to submit. */
  runtimeSettings?: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null
}

export async function createWorkspaceFromComposerSource(
  args: CreateWorkspaceFromComposerArgs
): Promise<WorktreeCreateResult> {
  if (args.selection.kind === 'branch') {
    return createBranchWorkspace({ ...args, selection: args.selection })
  }
  if (args.selection.kind === 'new-branch') {
    return createNewBranchWorkspace({ ...args, selection: args.selection })
  }
  return createWorkItemWorkspace({ ...args, selection: args.selection })
}

function resolveComposerAgentLaunch(
  agentId: TuiAgent | undefined,
  supported: WorktreeCreateAgentLaunch['supported']
): WorktreeCreateAgentLaunch | undefined {
  return agentId ? { agent: agentId, supported } : undefined
}

function toTaskItem(item: MobileLinkedWorkItem, targetRepoId: string): WorkspaceCreateTaskItem {
  if (item.provider === 'github') {
    return {
      provider: 'github',
      source: {
        type: item.type === 'pr' ? 'pr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  if (item.provider === 'gitlab') {
    return {
      provider: 'gitlab',
      source: {
        type: item.type === 'mr' ? 'mr' : 'issue',
        repoId: item.repoId ?? targetRepoId,
        number: item.number,
        title: item.title,
        url: item.url
      }
    }
  }
  return {
    provider: 'linear',
    source: {
      identifier: item.linearIdentifier ?? '',
      title: item.title,
      url: item.url,
      ...(item.linearWorkspaceId ? { workspaceId: item.linearWorkspaceId } : {}),
      ...(item.linearOrganizationUrlKey
        ? { organizationUrlKey: item.linearOrganizationUrlKey }
        : {})
    }
  }
}

async function createWorkItemWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'work-item' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  runtimeSettings?: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, workspaceName, note } = args
  const item = selection.item
  const taskItem = toTaskItem(item, targetRepoId)
  // The composer's work-item Start is the same Start as the Tasks tab's, so it takes the same
  // route: a structured session carries identity, a seeded terminal does not.
  const agentChoice = agent.choice
  const route = await resolveWorkItemStartRoute({
    client,
    settings: args.runtimeSettings,
    agent: agentChoice
  })
  // A strict Start that the host refused or never answered stops HERE, before any workspace
  // exists: creating one and seeding a terminal would be exactly the silent degradation.
  if (route.kind === 'refused' || route.kind === 'unknown') {
    return { error: route.message }
  }
  // `agentChoice !== 'blank'` first: an aliased condition is what lets TS narrow the agent below.
  const structuredStart = agentChoice !== 'blank' && route.kind === 'structured'
  if (structuredStart && !workItemStartAgentSupportsStructuredSession(agentChoice)) {
    return {
      error: `Work Item Start is set to submit after ready, which needs a structured agent session. ${agentChoice} does not have one — choose Claude or Codex, or set Work Item Start back to draft.`
    }
  }

  // The composer resolves PR/MR base at select time; only re-resolve as a
  // fallback when a linked PR/MR reached create without one.
  let baseBranch = selection.baseBranch
  let compareBaseRef = selection.compareBaseRef
  let pushTarget = selection.pushTarget
  let branchNameOverride = selection.branchNameOverride
  if (!baseBranch && item.provider !== 'linear' && (item.type === 'pr' || item.type === 'mr')) {
    const repoId = item.repoId ?? targetRepoId
    const resolved =
      item.type === 'pr'
        ? await resolveComposerPrBase({ client, repoId, prNumber: item.number }).catch(() => null)
        : await resolveComposerMrBase({ client, repoId, mrIid: item.number }).catch(() => null)
    if (resolved) {
      baseBranch = resolved.baseBranch
      compareBaseRef = resolved.compareBaseRef
      pushTarget = resolved.pushTarget
      branchNameOverride = resolved.branchNameOverride ?? branchNameOverride
    }
  }

  const params = buildTaskWorkspaceCreateParams({
    item: taskItem,
    targetRepoId,
    setupDecision,
    agent: agent.choice,
    workspaceName,
    note,
    baseBranch,
    compareBaseRef,
    branchNameOverride,
    pushTarget,
    nameIsAutoManaged: args.nameIsAutoManaged,
    structuredStart
  })
  // buildTaskWorkspaceCreateParams computes the name; reuse it as the retry base
  // so collisions still append -2, -3, ... like the blank path does.
  const baseName = String(params.name)
  // Deliberately NOT routed through `agent.launch`: an agent-carrying work-item create pre-fills
  // the issue/PR URL as an unsent `startupDraft`, and a structured session has nowhere to put one
  // — routing it would submit the URL as the first turn. A strict Start instead creates no startup
  // agent and opens its own scoped structured session below.
  const created = await createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    buildParams: (name) => ({ ...params, name })
  })
  if (!structuredStart || 'error' in created) {
    return created
  }
  const outcome = await startWorkItemStructuredSession({
    client,
    worktreeId: created.worktreeId,
    agent: agentChoice,
    prompt: item.url
  })
  if (outcome.kind === 'started') {
    return created
  }
  // The workspace exists and is listed; saying so in the same breath as the failure is what
  // keeps this from reading as "nothing happened".
  return { error: `${outcome.message} The workspace "${created.name}" was created.` }
}

async function createBranchWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'branch' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}): Promise<WorktreeCreateResult> {
  const {
    client,
    selection,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    nameIsAutoManaged,
    note
  } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const agentLaunch = resolveComposerAgentLaunch(createdWithAgentId, args.agentLaunchSupported)
  const comment = note?.trim()
  const manualDisplayName = nameIsAutoManaged === true ? undefined : workspaceName?.trim()
  const applyCommon = (params: WorkspaceCreateParams): WorkspaceCreateParams => {
    Object.assign(params, startupAgentCreateFields(createdWithAgentId))
    if (comment) {
      params.comment = comment
    }
    return params
  }

  if (selection.reuse) {
    // Reusing a fixed existing branch: branchNameOverride is pinned to the reused
    // branch, so a branch collision can't be cleared by suffixing the display
    // name — fail fast instead of burning the retry budget.
    const baseName = resolveMobileWorkspaceCreateName({
      draft: workspaceName,
      fallback: selection.localBranchName
    })
    return createWorktreeWithNameRetry({
      client,
      baseName,
      worktreeCreateIdempotency: args.worktreeCreateIdempotency,
      ...(agentLaunch ? { agentLaunch } : {}),
      maxAttempts: 1,
      buildParams: (name) =>
        applyCommon({
          repo: `id:${targetRepoId}`,
          name,
          ...(manualDisplayName
            ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
            : {}),
          setupDecision,
          baseBranch: selection.refName,
          branchNameOverride: selection.localBranchName
        })
    })
  }

  // New branch off the selected ref. The retry base is the branch name so a
  // collision bumps the branch itself.
  const baseName = resolveMobileWorkspaceCreateName({
    draft: workspaceName,
    fallback: selection.branchNameOverride || selection.localBranchName
  })
  return createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        baseBranch: selection.baseBranch,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {})
      }
      if (selection.branchNameOverride) {
        params.branchNameOverride = candidate
      }
      return applyCommon(params)
    }
  })
}

async function createNewBranchWorkspace(args: {
  client: RpcClient
  selection: Extract<MobileComposerCreateSelection, { kind: 'new-branch' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}): Promise<WorktreeCreateResult> {
  const {
    client,
    selection,
    targetRepoId,
    setupDecision,
    agent,
    workspaceName,
    nameIsAutoManaged,
    note
  } = args
  const createdWithAgentId = agent.choice === 'blank' ? undefined : agent.choice
  const agentLaunch = resolveComposerAgentLaunch(createdWithAgentId, args.agentLaunchSupported)
  const manualDisplayName = nameIsAutoManaged === true ? undefined : workspaceName?.trim()
  const comment = note?.trim()
  // A brand-new branch off the repo's default base. The typed name is kept as the
  // git branch (via branchNameOverride) so a slash like `feature/login` survives;
  // the runtime sanitizes the worktree folder from the same name. The retry base is
  // the branch name so a collision bumps the branch (and folder) together.
  return createWorktreeWithNameRetry({
    client,
    baseName: selection.branchName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        branchNameOverride: candidate,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {}),
        ...startupAgentCreateFields(createdWithAgentId)
      }
      if (comment) {
        params.comment = comment
      }
      return params
    }
  })
}
