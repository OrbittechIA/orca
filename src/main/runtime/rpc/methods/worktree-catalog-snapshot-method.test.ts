import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { hostStub } from './structured-agent-session-rpc.test-fixture'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { scopeWorktreePsStructuredIdentity } from './worktree-ps-structured-identity-scope'
import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { WORKTREE_METHODS } from './worktree'
import { WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../../shared/runtime-types'

function makeRuntime(...rows: RuntimeWorktreePsSummary[]) {
  return runtimeReturning(
    ...rows.map((row) => ({ worktrees: [row], totalCount: 1, truncated: false }))
  )
}

function runtimeReturning(...results: RuntimeWorktreePsResult[]) {
  const getWorktreePs = vi.fn().mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  for (const result of results) {
    getWorktreePs.mockResolvedValueOnce(result)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worktree.ps reads only these two runtime members.
  return { getRuntimeId: () => 'test-runtime', getWorktreePs } as unknown as OrcaRuntimeService
}

describe('worktree.ps catalog snapshots', () => {
  it('preserves the exact legacy response when no snapshot field is sent', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const response = await dispatcher.dispatch({
      id: 'legacy',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000 }
    })

    expect(response).toMatchObject({
      ok: true,
      result: { worktrees: [], totalCount: 0, truncated: false }
    })
    expect((response as { result: unknown }).result).not.toHaveProperty('snapshotId')
  })

  it('returns a full snapshot followed by a tiny unchanged response', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const first = await dispatcher.dispatch({
      id: 'first',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: null }
    })
    const snapshotId = (first as { result: { snapshotId: string } }).result.snapshotId

    const second = await dispatcher.dispatch({
      id: 'second',
      authToken: 'token',
      method: 'worktree.ps',
      params: { limit: 10_000, afterSnapshotId: snapshotId }
    })

    expect(snapshotId).toEqual(expect.any(String))
    expect(second).toMatchObject({
      ok: true,
      result: { unchanged: true, snapshotId }
    })
    expect(runtime.getWorktreePs).toHaveBeenCalledTimes(2)
  })

  it('gates source-default worktree projection by client capability', async () => {
    const runtime = makeRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    await dispatcher.dispatchStreaming(
      {
        id: 'legacy',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000 }
      },
      () => {},
      { clientCapabilities: [] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'current',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, includeAgentWait: true }
      },
      () => {},
      { clientCapabilities: [WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY] }
    )
    await dispatcher.dispatchStreaming(
      {
        id: 'mobile',
        authToken: 'token',
        method: 'worktree.ps',
        params: { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true }
      },
      () => {},
      { clientCapabilities: [] }
    )

    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(1, 10_000, false, false)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(2, 10_000, true, true)
    expect(runtime.getWorktreePs).toHaveBeenNthCalledWith(3, 10_000, true, false)
  })
})

function psRow(overrides: Partial<RuntimeWorktreePsSummary> = {}): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'repo-1::/w/a',
    repoId: 'repo-1',
    repo: 'repo',
    path: '/w/a',
    branch: 'feature',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: true,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'a',
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: 1_700_000_031_000,
    preview: 'building…',
    status: 'working',
    agents: [],
    ...overrides
  }
}

async function poll(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await dispatcher.dispatch({
    id: 'poll',
    authToken: 'token',
    method: 'worktree.ps',
    params
  })
  if (!response.ok || typeof response.result !== 'object' || response.result === null) {
    throw new Error(`worktree.ps failed: ${JSON.stringify(response)}`)
  }
  return { ...response.result }
}

describe('worktree.ps snapshot polls', () => {
  // Same 30 s bucket, different chunk: only the per-chunk activity fields moved.
  const before = psRow({ lastOutputAt: 1_700_000_031_000, preview: 'step 1' })
  const after = psRow({ lastOutputAt: 1_700_000_039_000, preview: 'step 2' })

  it('keeps the snapshot id while only fine-grained activity changes', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before, after),
      methods: WORKTREE_METHODS
    })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(first.worktrees).toEqual([{ ...before, preview: '', lastOutputAt: 1_700_000_010_000 }])
    expect(second).toEqual({ unchanged: true, snapshotId: first.snapshotId })
  })

  it('still reports output that crosses a bucket boundary', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before, psRow({ lastOutputAt: 1_700_000_071_000 })),
      methods: WORKTREE_METHODS
    })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(second.worktrees).toEqual([expect.objectContaining({ lastOutputAt: 1_700_000_070_000 })])
  })

  it('keeps the snapshot id while two active rows trade places inside one bucket', async () => {
    const a = (lastOutputAt: number) => psRow({ lastOutputAt })
    const b = (lastOutputAt: number) =>
      psRow({ lastOutputAt, worktreeId: 'repo-1::/w/b', path: '/w/b', displayName: 'b' })
    const runtime = runtimeReturning(
      { worktrees: [a(1_700_000_039_000), b(1_700_000_031_000)], totalCount: 2, truncated: false },
      { worktrees: [b(1_700_000_039_500), a(1_700_000_039_000)], totalCount: 2, truncated: false }
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    const second = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })

    expect(second).toEqual({ unchanged: true, snapshotId: first.snapshotId })
  })

  it('keeps a null lastOutputAt null', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(psRow({ lastOutputAt: null, preview: '' })),
      methods: WORKTREE_METHODS
    })
    const result = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })

    expect(result.worktrees).toEqual([expect.objectContaining({ lastOutputAt: null })])
  })

  it('returns byte-identical rows, preview included, to callers that do not poll snapshots', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(before),
      methods: WORKTREE_METHODS
    })

    expect(JSON.stringify(await poll(dispatcher, { limit: 10_000 }))).toBe(
      JSON.stringify({ worktrees: [before], totalCount: 1, truncated: false })
    )
  })
})

describe('worktree.ps structured identity admission', () => {
  const agent = {
    sessionId: 'codex_session_12345678',
    paneKey: 'structured-pane',
    parentPaneKey: null,
    state: 'working' as const,
    agentType: 'codex' as const,
    prompt: 'keep the official row',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 1
  }

  it('publishes the validated summary identity only to its persisted exact owner', () => {
    const previous = getStructuredAgentSessionHost()
    const host = hostStub()
    const record = { ...agentSessionRecordFixture(), sessionId: agent.sessionId,
      launchOrigin: 'work-item-start' as const,
      launchAuthority: { kind: 'paired-device' as const, deviceId: 'owner' } }
    vi.spyOn(host.deps.store, 'getRecord').mockReturnValue(record)
    setStructuredAgentSessionHost(host)
    try {
      const result = { worktrees: [psRow({ agents: [agent] })], totalCount: 1, truncated: false }
      expect(scopeWorktreePsStructuredIdentity(result, { caller: { kind: 'paired-device', deviceId: 'owner' } })).toBe(result)
      for (const caller of [{ kind: 'paired-device', deviceId: 'foreign' }, { kind: 'desktop' }, { kind: 'local-cli' }] as const) {
        expect(scopeWorktreePsStructuredIdentity(result, { caller }).worktrees[0]?.agents[0]?.sessionId).toBeUndefined()
      }
      expect(result.worktrees[0]?.agents[0]?.sessionId).toBe(agent.sessionId)
    } finally {
      setStructuredAgentSessionHost(previous)
    }
  })

  it.each([
    { kind: 'local-cli' as const },
    { kind: 'desktop' as const },
    { kind: 'paired-device' as const, deviceId: 'another-device' }
  ])('omits identity for $kind when per-session ownership is unknown', async (caller) => {
    const row = psRow({ agents: [agent] })
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(row), methods: WORKTREE_METHODS })
    const response = await dispatcher.dispatchStreaming(
      { id: 'identity', authToken: 'token', method: 'worktree.ps', params: { limit: 10_000 } },
      () => {},
      { caller }
    )
    const { sessionId: _sessionId, ...visible } = agent
    expect(response).toMatchObject({ ok: true, result: { worktrees: [{ agents: [visible] }] } })
    expect(JSON.stringify(response)).not.toContain('"sessionId"')
    expect(row.agents[0]?.sessionId).toBe(agent.sessionId)
  })

  it('filters before snapshot hashing so withheld identities cannot change a caller snapshot', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: makeRuntime(
        psRow({ agents: [agent] }),
        psRow({ agents: [{ ...agent, sessionId: 'codex_another_session' }] })
      ),
      methods: WORKTREE_METHODS
    })
    const first = await poll(dispatcher, { limit: 10_000, afterSnapshotId: null })
    expect(JSON.stringify(first)).not.toContain('"sessionId"')
    const next = await poll(dispatcher, { limit: 10_000, afterSnapshotId: first.snapshotId })
    expect(next).toEqual({ unchanged: true, snapshotId: first.snapshotId })
  })
})
