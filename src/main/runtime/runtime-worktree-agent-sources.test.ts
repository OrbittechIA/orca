import { describe, expect, it } from 'vitest'
import { collectRuntimeWorktreeAgentSources } from './runtime-worktree-agent-sources'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

const paneKey = 'worktree:tab:0'
const now = Date.now()
const hookRow: AgentStatusIpcPayload = {
  paneKey,
  tabId: 'tab',
  terminalHandle: 'term_row',
  worktreeId: 'worktree',
  connectionId: null,
  state: 'working',
  prompt: 'implement',
  agentType: 'codex',
  stateStartedAt: now,
  receivedAt: now
}
const base = {
  hookSnapshots: [hookRow],
  mirroredWorktreeIdByTabId: new Map<string, string>(),
  connectedPtyEvidence: {
    tabIds: new Set<string>(),
    paneKeys: new Set<string>(),
    ptyIdByTerminalHandle: new Map<string, string>()
  }
}
const connected = {
  ...base,
  connectedPtyEvidence: {
    tabIds: new Set(['tab']),
    paneKeys: new Set([paneKey]),
    ptyIdByTerminalHandle: new Map([['term_row', 'pty']])
  }
}

describe('worktree agent source admission', () => {
  it('rejects a disconnected local terminal before row assembly', () => {
    expect(collectRuntimeWorktreeAgentSources(base).size).toBe(0)
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.state).toBe('working')
  })

  it('keeps remote evidence and resolves mirrored workspace ownership', () => {
    const remote = { ...hookRow, connectionId: 'ssh-connection' }
    expect(collectRuntimeWorktreeAgentSources({ ...base, hookSnapshots: [remote] }).size).toBe(1)
    const sources = collectRuntimeWorktreeAgentSources({
      ...base,
      mirroredWorktreeIdByTabId: new Map([['tab', 'remote-worktree']])
    })
    expect(sources.get(paneKey)?.worktreeId).toBe('remote-worktree')
  })

  it('marks only rows a connected PTY backs as live', () => {
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.hasLivePty).toBe(true)
    const remote = { ...hookRow, connectionId: 'ssh-connection' }
    expect(
      collectRuntimeWorktreeAgentSources({ ...base, hookSnapshots: [remote] }).get(paneKey)
        ?.hasLivePty
    ).toBeUndefined()
  })

  it('rejoins the row to the connected PTY behind its terminal handle', () => {
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)?.ptyId).toBe('pty')
    // The handle is the last rescue once a controller incarnation nulls the pane binding.
    const bindingCleared = collectRuntimeWorktreeAgentSources({
      ...base,
      connectedPtyEvidence: {
        ...base.connectedPtyEvidence,
        ptyIdByTerminalHandle: new Map([['term_row', 'pty']])
      }
    })
    expect(bindingCleared.get(paneKey)?.ptyId).toBe('pty')
    // No connected PTY answers to the handle and no pane evidence: the row is not admitted.
    expect(collectRuntimeWorktreeAgentSources(base).size).toBe(0)
  })

  it('carries the row own working mode and drops non-live rows', () => {
    const monitoring = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, workingMode: 'monitoring' as const }]
    })
    expect(monitoring.get(paneKey)).toMatchObject({ updatedAt: now, workingMode: 'monitoring' })

    const restored = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, restoredUnconfirmed: true as const }]
    })
    expect(restored.size).toBe(0)

    const providerSessionOnly = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, providerSessionOnly: true }]
    })
    expect(providerSessionOnly.size).toBe(0)
  })

  it('carries the pane facet from the hook row to the source', () => {
    const programStatus = { state: 'working' as const, progress: 42, observedAt: now }
    const sources = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [{ ...hookRow, programStatus }]
    })
    expect(sources.get(paneKey)?.programStatus).toEqual(programStatus)
    expect(collectRuntimeWorktreeAgentSources(connected).get(paneKey)).not.toHaveProperty(
      'programStatus'
    )
  })
})

describe('published structured session identity', () => {
  const sessionId = 'codex_session_12345678'
  const tabId = structuredAgentSessionTabId(sessionId)
  const paneKey = structuredAgentSessionPaneKey(tabId, sessionId)
  const entry: AgentStatusIpcPayload = {
    ...hookRow,
    tabId,
    paneKey,
    structuredHost: 'owned',
    prompt: `sessionId=${sessionId}`
  }
  const summary: AgentSessionStatusSummary = {
    sessionId,
    workspaceId: 'worktree',
    agent: 'codex',
    status: 'working',
    latestPrompt: entry.prompt,
    hostExecutionOwned: true,
    updatedAt: now
  }

  function sources(
    snapshot: AgentStatusIpcPayload = entry,
    published: AgentSessionStatusSummary | undefined = summary,
    mirrored = new Map<string, string>()
  ) {
    return [
      ...collectRuntimeWorktreeAgentSources({
        ...connected,
        hookSnapshots: [snapshot],
        mirroredWorktreeIdByTabId: mirrored,
        readStructuredSummary: () => published
      }).values()
    ]
  }

  it('forwards identity only from the exact published host summary', () => {
    expect(sources()[0]).toMatchObject({ sessionId, children: [] })
    const missing = collectRuntimeWorktreeAgentSources({
      ...connected,
      hookSnapshots: [entry],
      readStructuredSummary: () => undefined
    })
    expect(missing.get(paneKey)).not.toHaveProperty('sessionId')
    for (const published of [
      { ...summary, sessionId: 'another_session_12345678' },
      { ...summary, workspaceId: 'another-worktree' }
    ]) {
      expect(sources(entry, published)[0]).not.toHaveProperty('sessionId')
    }
  })

  it('keeps remote and terminal text rows without turning their text into identity', () => {
    for (const snapshot of [
      { ...entry, connectionId: 'ssh-connection' },
      { ...entry, structuredHost: undefined },
      { ...entry, tabId: undefined },
      { ...entry, tabId: 'another-tab' },
      { ...entry, paneKey: 'another-pane' }
    ]) {
      const rows = sources(snapshot)
      expect(rows).toHaveLength(1)
      expect(rows[0]).not.toHaveProperty('sessionId')
      expect(rows[0]?.prompt).toBe(entry.prompt)
    }
  })

  it('does not retain identity when mirrored topology moves the row to another workspace', () => {
    expect(sources(entry, summary, new Map([[tabId, 'another-worktree']]))[0]).toMatchObject({
      worktreeId: 'another-worktree'
    })
    expect(sources(entry, summary, new Map([[tabId, 'another-worktree']]))[0]).not.toHaveProperty(
      'sessionId'
    )
  })
})
