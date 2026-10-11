import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'
import type { WorktreeCreateResult } from './worktree-create-retry'
import {
  resolveWorkItemStartRoute,
  workItemStartAgentSupportsStructuredSession,
  type WorkItemStartRepo
} from './work-item-start-route'
import { startWorkItemStructuredSession } from './work-item-start-structured-session'

// The composer's work-item Start is the same Start as the Tasks tab's, so it takes the same route:
// a structured session carries identity, a seeded terminal does not.

/**
 * Decided before any workspace exists. A strict Start the host refused or never answered stops
 * here: creating one and seeding a terminal would be exactly the silent degradation.
 */
export async function resolveComposerWorkItemStart(args: {
  client: RpcClient
  settings: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined
  agent: TuiAgent | 'blank'
  repo: WorkItemStartRepo
}): Promise<{ error: string } | { structuredAgent: TuiAgent | null }> {
  const route = await resolveWorkItemStartRoute(args)
  if (route.kind === 'refused' || route.kind === 'unknown') {
    return { error: route.message }
  }
  if (args.agent === 'blank' || route.kind !== 'structured') {
    return { structuredAgent: null }
  }
  if (!workItemStartAgentSupportsStructuredSession(args.agent)) {
    return {
      error: `Work Item Start is set to submit after ready, which needs a structured agent session. ${args.agent} does not have one — choose Claude or Codex, or set Work Item Start back to draft.`
    }
  }
  return { structuredAgent: args.agent }
}

/** Opens the created workspace's one structured session and delivers the work item once. */
export async function finishComposerWorkItemStart(args: {
  client: RpcClient
  created: WorktreeCreateResult
  structuredAgent: TuiAgent | null
  prompt: string
}): Promise<WorktreeCreateResult> {
  const { created, structuredAgent } = args
  if (!structuredAgent || 'error' in created) {
    return created
  }
  const outcome = await startWorkItemStructuredSession({
    client: args.client,
    worktreeId: created.worktreeId,
    worktreeName: created.name,
    agent: structuredAgent,
    prompt: args.prompt
  })
  if (outcome.kind === 'started') {
    return created
  }
  // The workspace exists, so this is a created result with a warning, never an error: an error
  // keeps the drawer's Create armed, and tapping it again would create a second workspace. Any
  // retry happens on the workspace, under the attempt recorded for it.
  const warning = [outcome.message, 'warning' in created ? created.warning : undefined]
    .filter(Boolean)
    .join(' ')
  return { ...created, warning }
}
