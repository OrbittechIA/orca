import { resolveMobileWorkItemStartRoute } from './work-item-start-route'
import { deliverMobileWorkItemStart } from './work-item-start-delivery'
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
import type { WorktreeCreateAgentLaunch } from './agent-launch-request'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'
import { getClientWorktreeCreateCandidate } from '../../../src/shared/new-workspace/worktree-create-retry-policy'

// Host resolution applies agent permission flags and shell quoting.
export type WorkspaceCreateAgentBundle = {
  choice: WorkspaceAgentChoice
}

export type CreateWorkspaceFromComposerArgs = {
  client: RpcClient
  hostId?: string
  selection: MobileComposerCreateSelection
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
  branchIntentSupported?: boolean | Promise<boolean>
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
  if (item.provider === 'jira') {
    return {
      provider: 'jira',
      source: {
        key: item.jiraIdentifier ?? '',
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
  hostId?: string
  selection: Extract<MobileComposerCreateSelection, { kind: 'work-item' }>
  targetRepoId: string
  setupDecision: WorkspaceCreateSetupDecision
  agent: WorkspaceCreateAgentBundle
  workspaceName: string | undefined
  nameIsAutoManaged?: boolean
  note: string | undefined
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
}): Promise<WorktreeCreateResult> {
  const { client, selection, targetRepoId, setupDecision, agent, workspaceName, note } = args
  const item = selection.item
  const taskItem = toTaskItem(item, targetRepoId)
  const selectedAgent = agent.choice === 'blank' ? undefined : agent.choice
  const startRepoId =
    taskItem.provider === 'github' || taskItem.provider === 'gitlab'
      ? taskItem.source.repoId
      : targetRepoId
  const startGeneration = client.getGeneration?.()
  const route = await resolveMobileWorkItemStartRoute(client, startRepoId, selectedAgent, {
    hostId: args.hostId ?? '',
    prompt: item.url
  })

  // Reuse select-time PR/MR base resolution; resolve again only when a linked item lacks it.
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
    structuredStart: route.kind === 'structured',
    workspaceName,
    note,
    baseBranch,
    compareBaseRef,
    branchNameOverride,
    pushTarget,
    nameIsAutoManaged: args.nameIsAutoManaged
  })
  // Reuse the computed name for collision suffixes, matching blank-workspace creation.
  const baseName = String(params.name)
  const result = await createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    buildParams: (name) => ({ ...params, name })
  })
  if ('error' in result || route.kind !== 'structured' || !selectedAgent) return result
  try {
    if (startGeneration !== client.getGeneration?.()) {
      throw new Error(
        'The connection changed during Work Item Start. Review the created workspace before sending anything.'
      )
    }
    const warning = await deliverMobileWorkItemStart({
      client,
      hostId: args.hostId ?? '',
      worktreeId: result.worktreeId,
      agent: selectedAgent,
      prompt: item.url
    })
    return {
      ...result,
      ...(warning ? { warning: [result.warning, warning].filter(Boolean).join(' ') } : {})
    }
  } catch (error) {
    const warning =
      error instanceof Error
        ? error.message
        : 'Work Item Start requires recovery in this workspace.'
    return { ...result, warning: [result.warning, warning].filter(Boolean).join(' ') }
  }
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
  branchIntentSupported?: boolean | Promise<boolean>
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
    // A reused branch is fixed; display-name suffixes cannot resolve its collision, so fail before wasting retries.
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
      branchIntentSupported: args.branchIntentSupported,
      buildParams: (name) =>
        applyCommon({
          repo: `id:${targetRepoId}`,
          name,
          ...(manualDisplayName
            ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
            : {}),
          setupDecision,
          baseBranch: selection.refName,
          branchNameOverride: selection.localBranchName,
          branchIntent: 'open-existing-v2'
        })
    })
  }

  const baseName = resolveMobileWorkspaceCreateName({
    draft: workspaceName,
    fallback: selection.branchNameOverride || selection.localBranchName
  })
  return createWorktreeWithNameRetry({
    client,
    baseName,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    branchIntentSupported: args.branchIntentSupported,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (candidate, attempt) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${targetRepoId}`,
        name: candidate,
        setupDecision,
        branchIntent: 'create-new',
        baseBranch: selection.baseBranch,
        ...(manualDisplayName
          ? { displayName: manualDisplayName, displayNameKind: 'user' as const }
          : {})
      }
      if (selection.branchNameOverride) {
        params.branchNameOverride = getClientWorktreeCreateCandidate(
          selection.branchNameOverride,
          attempt
        )
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
  // Preserve typed git branch names, including slashes; sanitize only the folder, and retry suffixes against the branch name.
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
