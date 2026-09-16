import { describe, expect, it, vi } from 'vitest'
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
    runtimeSettings: { workItemStartPromptDelivery: delivery }
  }
}

function createParams(client: { sendRequest: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  const call = client.sendRequest.mock.calls.find((entry) => entry[0] === 'worktree.create')
  return (call?.[1] ?? {}) as Record<string, unknown>
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
    const support = client.sendRequest.mock.calls.find(
      (entry) => entry[0] === 'agentSession.createSupport'
    )?.[1] as { launchOrigin?: string }
    expect(support.launchOrigin).toBe('work-item-start')
  })

  it('keeps the terminal draft when the host does not admit the route', async () => {
    const client = routedClient({
      'status.get': [{ ok: true, result: { capabilities: [], deviceScope: 'runtime' } }],
      'worktree.create': [CREATED]
    })

    await expect(
      createWorkspaceFromComposerSource(composerArgs(client, 'submit-after-ready'))
    ).resolves.toEqual({ worktreeId: 'wt-1', name: 'Caderno' })

    expect(createParams(client).startupDraft).toBe(ISSUE_URL)
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
