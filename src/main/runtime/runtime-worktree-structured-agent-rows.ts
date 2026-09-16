import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { RuntimeWorktreeAgentRow, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'

function runtimeStateForStructuredStatus(
  status: AgentSessionStatusSummary['status']
): AgentStatusState {
  if (status === 'working') {
    return 'working'
  }
  if (status === 'attention') {
    return 'blocked'
  }
  return 'done'
}

export function attachRuntimeWorktreeStructuredAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingWorktreeIds: Set<string>
  statuses: readonly AgentSessionStatusSummary[]
  getSummary: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    pathIndex: RuntimeWorktreeSummaryPathIndex,
    missingWorktreeIds: Set<string>,
    worktreeId: string
  ) => RuntimeWorktreePsSummary | null
}): void {
  for (const status of args.statuses) {
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingWorktreeIds,
      status.workspaceId
    )
    if (!summary) {
      continue
    }
    const tabId = structuredAgentSessionTabId(status.sessionId)
    const paneKey = structuredAgentSessionPaneKey(tabId, status.sessionId)
    // The hook store already holds this session under the SAME pane key (the host publishes
    // every projection into it through the status sink), but that row carries no `sessionId`.
    // One session, one row: the host's projection wins on identity and status, and keeps what
    // only the hook-store row knows (orchestration naming, host ownership).
    const existing = summary.agents.find(
      (entry) => entry.paneKey === paneKey || entry.sessionId === status.sessionId
    )
    const row: RuntimeWorktreeAgentRow = {
      ...(existing?.workingMode ? { workingMode: existing.workingMode } : {}),
      ...(existing?.structuredHostOwned ? { structuredHostOwned: true as const } : {}),
      paneKey,
      sessionId: status.sessionId,
      ...(status.providerSession
        ? {
            providerSession: {
              key: status.providerSession.key,
              id: status.providerSession.id
            }
          }
        : {}),
      parentPaneKey: existing?.parentPaneKey ?? null,
      state: runtimeStateForStructuredStatus(status.status),
      agentType: status.agent,
      prompt: status.latestPrompt,
      taskTitle: existing?.taskTitle ?? null,
      displayName: existing?.displayName ?? null,
      lastAssistantMessage: status.lastAssistantMessage ?? null,
      toolName: status.toolName ?? null,
      toolInput: status.toolInput ?? null,
      interrupted: false,
      stateStartedAt: status.updatedAt,
      updatedAt: status.updatedAt
    }
    summary.agents = [...summary.agents.filter((entry) => entry !== existing), row]
    summary.agents.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
    if (status.status === 'working') {
      summary.hasHostSidebarActivity = true
      mergeWorktreeSummaryStatus(summary, 'working')
    } else if (status.status === 'attention') {
      summary.hasHostSidebarActivity = true
      mergeWorktreeSummaryStatus(summary, 'permission')
    }
  }
}
