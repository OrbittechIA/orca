import { isUnknownRecord } from '../../../src/shared/unknown-record'
import { describe, expect, it, vi } from 'vitest'

// The Start persists its send envelope before dispatching it; an in-memory AsyncStorage is enough.
const asyncStorage = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key)
    })
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { createWorkspaceFromComposerSource } from './source-workspace-create'
import { retryWorkItemStartStructuredSession } from './work-item-start-structured-session'

// The composer's "new workspace from a work item" is the same Work Item Start as the Tasks tab's.
// Before it took the structured route it seeded a terminal with the issue URL, and that pane
// carried no session identity — the exact shape that leaves `worktree ps` reporting `agents: []`.

const CAP = WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
const ISSUE_URL = 'https://github.com/OrbittechIA/av1-medicina-unibh-builder/issues/387'

const ADMITTED_STATUS = {
  ok: true,
  result: { capabilities: [CAP], deviceScope: 'runtime' }
}
const CREATED = { ok: true, result: { worktree: { id: 'wt-1', displayName: 'Caderno' } } }
const SUPPORTED = { ok: true, result: { supported: true } }

function sessionCreated(fence = 2): unknown {
  return {
    ok: true,
    result: {
      ok: true,
      fence,
      value: { sessionId: 'codex_s1', fence, page: {}, unconfirmedClientMessageIds: [] }
    }
  }
}

const ACCEPTED_SEND = {
  ok: true,
  result: {
    ok: true,
    value: { clientMessageId: 'm1', submission: { dispatchState: 'accepted' } }
  }
}

function routedClient(byMethod: Record<string, unknown[]>): RpcClient & {
  sendRequest: ReturnType<typeof vi.fn>
} {
  const cursors: Record<string, number> = {}
  const sendRequest = vi.fn(async (method: string) => {
    const queue = byMethod[method]
    if (!queue) {
      throw new Error(`unexpected method ${method}`)
    }
    const index = cursors[method] ?? 0
    cursors[method] = index + 1
    const next = queue[Math.min(index, queue.length - 1)]
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function composerArgs(client: RpcClient, delivery: 'draft' | 'submit-after-ready') {
  return {
    client,
    selection: {
      kind: 'work-item' as const,
      item: {
        provider: 'github' as const,
        type: 'issue' as const,
        number: 387,
        title: 'Caderno Visual-01',
        url: ISSUE_URL,
        repoId: 'repo-1'
      }
    },
    targetRepoId: 'repo-1',
    targetRepo: { id: 'repo-1', path: '/repos/orca', connectionId: null },
    setupDecision: 'run' as const,
    agent: { choice: 'codex' as const },
    workspaceName: undefined,
    note: undefined,
    worktreeCreateIdempotency: false as const,
    agentLaunchSupported: false as const,
    runtimeSettings: { workItemStartPromptDelivery: delivery }
  }
}

function paramsOf(method: string, client: { sendRequest: ReturnType<typeof vi.fn> }) {
  const params: unknown = client.sendRequest.mock.calls.find((entry) => entry[0] === method)?.[1]
  return isUnknownRecord(params) ? params : {}
}

/** The post-create probes; the pre-create one names the repo and carries no session. */
function sessionProbeParams(client: {
  sendRequest: ReturnType<typeof vi.fn>
}): Record<string, unknown>[] {
  return client.sendRequest.mock.calls
    .filter((entry) => entry[0] === 'agentSession.createSupport')
    .map((entry): unknown => entry[1])
    .filter(isUnknownRecord)
    .filter((params) => params.repo === undefined)
}

function methodsOf(client: { sendRequest: ReturnType<typeof vi.fn> }): unknown[] {
  return client.sendRequest.mock.calls.map((entry) => entry[0])
}

function createParams(client: { sendRequest: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  return paramsOf('worktree.create', client)
}

describe('composer work item Start', () => {
  it('takes the structured route and never seeds a terminal with the issue URL', async () => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [SUPPORTED],
      'agentSession.create': [sessionCreated()],
      'agentSession.send': [ACCEPTED_SEND]
    })

    await expect(
      createWorkspaceFromComposerSource(composerArgs(client, 'submit-after-ready'))
    ).resolves.toEqual({ worktreeId: 'wt-1', name: 'Caderno' })

    expect(createParams(client).startupDraft).toBeUndefined()
    expect(createParams(client).createdWithAgent).toBe('codex')
    expect(paramsOf('agentSession.createSupport', client).launchOrigin).toBe('work-item-start')
  })

  it.each([
    [
      'an old host without the route',
      { ok: true, result: { capabilities: [], deviceScope: 'runtime' } }
    ],
    [
      'a pairing scoped mobile',
      { ok: true, result: { capabilities: [CAP], deviceScope: 'mobile' } }
    ],
    ['a status probe that failed', new Error('status.get timed out')],
    ['a status probe the host refused', { ok: false, error: { code: 'runtime_busy' } }]
  ] as const)('stops a strict Start before worktree.create against %s', async (_name, status) => {
    const client = routedClient({ 'status.get': [status], 'worktree.create': [CREATED] })
    const result = await createWorkspaceFromComposerSource(
      composerArgs(client, 'submit-after-ready')
    )
    expect(result).toMatchObject({ error: expect.stringContaining('submit after ready') })
    // Nothing exists: no workspace, so no terminal could have been seeded in the session's place.
    expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual(['status.get'])
  })

  it('never substitutes the terminal draft for a strict Start the host does not admit', async () => {
    // This used to "keep the terminal draft": a strict Start silently degraded to the legacy
    // terminal writer whenever the host said no. Now nothing is created.
    const client = routedClient({
      'status.get': [{ ok: true, result: { capabilities: [], deviceScope: 'runtime' } }],
      'worktree.create': [CREATED]
    })

    await expect(
      createWorkspaceFromComposerSource(composerArgs(client, 'submit-after-ready'))
    ).resolves.toMatchObject({ error: expect.stringContaining('no terminal was started') })

    expect(createParams(client)).toEqual({})
  })

  it('keeps the terminal draft in draft mode without probing the host', async () => {
    const client = routedClient({ 'worktree.create': [CREATED] })

    await expect(createWorkspaceFromComposerSource(composerArgs(client, 'draft'))).resolves.toEqual(
      { worktreeId: 'wt-1', name: 'Caderno' }
    )

    expect(createParams(client).startupDraft).toBe(ISSUE_URL)
    expect(client.sendRequest.mock.calls.some((entry) => entry[0] === 'status.get')).toBe(false)
  })

  it('returns the created workspace with a warning, so the drawer cannot create another', async () => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      // Supported before create, then WSL once the workspace exists: the post-create verdict still wins.
      'agentSession.createSupport': [
        SUPPORTED,
        { ok: true, result: { supported: false, reason: 'wsl' } }
      ]
    })

    const result = await createWorkspaceFromComposerSource(
      composerArgs(client, 'submit-after-ready')
    )

    // A created result closes the drawer; an error would leave Create armed for a second workspace.
    expect(result).toMatchObject({ worktreeId: 'wt-1', name: 'Caderno' })
    expect('warning' in result && result.warning).toContain('inside WSL')
    // No terminal was opened in the session's place.
    expect(createParams(client).startupDraft).toBeUndefined()
  })

  it.each([
    ['an SSH repo', { id: 'repo-1', path: '/srv/orca', connectionId: 'ssh-1' }],
    ['a WSL checkout', { id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }]
  ])('refuses %s before worktree.create with zero side effects', async (_label, targetRepo) => {
    const client = routedClient({ 'status.get': [ADMITTED_STATUS], 'worktree.create': [CREATED] })

    const result = await createWorkspaceFromComposerSource({
      ...composerArgs(client, 'submit-after-ready'),
      targetRepo
    })

    expect(result).toMatchObject({ error: expect.stringContaining('Nothing was created') })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('leaves a retry on the same workspace and session after an unconfirmed Start', async () => {
    const lost = new Error('socket closed')
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [SUPPORTED, lost]
    })

    const result = await createWorkspaceFromComposerSource(
      composerArgs(client, 'submit-after-ready')
    )
    expect(result).toMatchObject({ worktreeId: 'wt-1' })
    const firstSessionId = sessionProbeParams(client)[0]?.sessionId

    client.sendRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'agentSession.createSupport') {
        return { ok: true, result: { supported: true } }
      }
      if (method === 'agentSession.create') {
        const envelope =
          isUnknownRecord(params) && isUnknownRecord(params.envelope) ? params.envelope : {}
        return createdSessionReply(String(envelope.sessionId))
      }
      return {
        ok: true,
        result: { ok: true, value: { submission: { dispatchState: 'accepted' } } }
      }
    })
    await expect(
      retryWorkItemStartStructuredSession({ client, worktreeId: 'wt-1' })
    ).resolves.toMatchObject({ kind: 'started', sessionId: firstSessionId })

    const methods = client.sendRequest.mock.calls.map((entry) => entry[0])
    expect(methods.filter((method) => method === 'worktree.create')).toHaveLength(1)
    const sessionIds = new Set(
      client.sendRequest.mock.calls
        .filter((entry) => String(entry[0]).startsWith('agentSession.create'))
        .filter((entry) => !isUnknownRecord(entry[1]) || entry[1].repo === undefined)
        .map((entry) => {
          const params: unknown = entry[1]
          if (!isUnknownRecord(params)) {
            return undefined
          }
          return isUnknownRecord(params.envelope) ? params.envelope.sessionId : params.sessionId
        })
    )
    expect(sessionIds).toEqual(new Set([firstSessionId]))
  })
})

describe('composer strict Start asks the host about the repo before worktree.create', () => {
  it('continues into exactly one create when the host supports the repo', async () => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [SUPPORTED],
      'agentSession.create': [sessionCreated()],
      'agentSession.send': [ACCEPTED_SEND]
    })

    await expect(
      createWorkspaceFromComposerSource(composerArgs(client, 'submit-after-ready'))
    ).resolves.toEqual({ worktreeId: 'wt-1', name: 'Caderno' })

    const methods = methodsOf(client)
    expect(methods.slice(0, 3)).toEqual([
      'status.get',
      'agentSession.createSupport',
      'worktree.create'
    ])
    expect(methods.filter((method) => method === 'worktree.create')).toHaveLength(1)
    expect(paramsOf('agentSession.createSupport', client)).toEqual({
      repo: 'id:repo-1',
      agent: 'codex',
      launchOrigin: 'work-item-start'
    })
  })

  it.each([
    ['a C:\\ repo whose project runs in WSL', 'C:\\src\\orca', 'wsl', 'inside WSL'],
    ['a repo the host reports remote', '/repos/orca', 'remote', 'remote execution host'],
    ['an agent the host cannot open here', '/repos/orca', 'agent', 'for this agent']
  ])('creates nothing for %s', async (_label, path, reason, text) => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [{ ok: true, result: { supported: false, reason } }]
    })

    const result = await createWorkspaceFromComposerSource({
      ...composerArgs(client, 'submit-after-ready'),
      targetRepo: { id: 'repo-1', path, connectionId: null }
    })

    expect(result).toMatchObject({ error: expect.stringContaining(text) })
    expect('error' in result && result.error).toContain('Nothing was created')
    expect('error' in result && result.error).not.toContain('without an agent')
    expect(methodsOf(client)).toEqual(['status.get', 'agentSession.createSupport'])
  })

  it.each([
    ['an older host without the method', { ok: false, error: { code: 'method_not_found' } }],
    ['an older host rejecting the repo params', { ok: false, error: { code: 'invalid_argument' } }],
    ['a dropped reply', new Error('socket closed')],
    ['an empty reply', undefined],
    ['a reply without a verdict', { ok: true, result: {} }],
    ['a verdict of unknown shape', { ok: true, result: { supported: 'maybe' } }]
  ])('fails closed with zero create against %s', async (_label, reply) => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [reply]
    })

    const result = await createWorkspaceFromComposerSource(
      composerArgs(client, 'submit-after-ready')
    )

    expect(result).toMatchObject({ error: expect.stringContaining('Nothing was created') })
    expect(methodsOf(client)).toEqual(['status.get', 'agentSession.createSupport'])
  })

  it('leaves draft mode on the legacy create with no repo probe', async () => {
    const client = routedClient({ 'worktree.create': [CREATED] })

    await expect(createWorkspaceFromComposerSource(composerArgs(client, 'draft'))).resolves.toEqual(
      { worktreeId: 'wt-1', name: 'Caderno' }
    )

    expect(methodsOf(client)).toEqual(['worktree.create'])
    expect(createParams(client).startupDraft).toBe(ISSUE_URL)
  })
})

function createdSessionReply(sessionId: string): unknown {
  return {
    ok: true,
    result: { ok: true, replayed: false, fence: 2, value: { sessionId, fence: 2 } }
  }
}
