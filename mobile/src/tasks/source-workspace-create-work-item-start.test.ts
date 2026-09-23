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
    return queue[Math.min(index, queue.length - 1)]
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

  it('names the created workspace when the session start does not land', async () => {
    const client = routedClient({
      'status.get': [ADMITTED_STATUS],
      'worktree.create': [CREATED],
      'agentSession.createSupport': [{ ok: true, result: { supported: false, reason: 'wsl' } }]
    })

    const result = await createWorkspaceFromComposerSource(
      composerArgs(client, 'submit-after-ready')
    )

    expect('error' in result).toBe(true)
    expect('error' in result && result.error).toContain('"Caderno" was created')
    // No terminal was opened in the session's place.
    expect(createParams(client).startupDraft).toBeUndefined()
  })
})
