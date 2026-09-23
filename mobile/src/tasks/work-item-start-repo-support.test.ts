import { isUnknownRecord } from '../../../src/shared/unknown-record'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { resolveWorkItemStartRoute } from './work-item-start-structured-session'

// A strict Start asks the host about the SOURCE repo before `worktree.create`: only the host knows
// the runtime the workspace will run in, so a `C:\\` repo set to WSL looks native from here.

function clientReturning(
  ...responses: unknown[]
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  let index = 0
  const sendRequest = vi.fn(async () => {
    const next = responses[index++]
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: route resolution only calls sendRequest.
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

function paramsOf(params: unknown): Record<string, unknown> {
  return isUnknownRecord(params) ? params : {}
}

const SUPPORTED = { ok: true, result: { supported: true } }
const LOCAL_REPO = { id: 'repo-1', path: '/repos/orca', connectionId: null }

describe('strict Start reads the host repo verdict before anything is created', () => {
  const strict = { workItemStartPromptDelivery: 'submit-after-ready' as const }
  const ADMITTED = {
    ok: true,
    result: {
      capabilities: [WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY],
      deviceScope: 'runtime'
    }
  }

  it('asks after admission, naming the repo and the Start origin', async () => {
    const client = clientReturning(ADMITTED, SUPPORTED)
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'claude', repo: LOCAL_REPO })
    ).resolves.toEqual({ kind: 'structured' })
    expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'status.get',
      'agentSession.createSupport'
    ])
    expect(paramsOf(client.sendRequest.mock.calls[1]?.[1])).toEqual({
      repo: 'id:repo-1',
      agent: 'claude',
      launchOrigin: 'work-item-start'
    })
  })

  it.each([
    ['wsl', { id: 'repo-1', path: 'C:\\src\\orca' }, 'inside WSL'],
    ['remote', LOCAL_REPO, 'remote execution host'],
    ['agent', LOCAL_REPO, 'selected agent or its active account']
  ])('turns a host reason:%s into a truthful refusal', async (reason, repo, text) => {
    const client = clientReturning(ADMITTED, { ok: true, result: { supported: false, reason } })
    const route = await resolveWorkItemStartRoute({
      client,
      settings: strict,
      agent: 'codex',
      repo
    })
    expect(route).toMatchObject({ kind: 'refused', message: expect.stringContaining(text) })
    expect('message' in route && route.message).toContain('Nothing was created')
    expect('message' in route && route.message).not.toContain('without an agent')
    if (reason !== 'wsl') {
      expect('message' in route && route.message).not.toContain('WSL')
    }
  })

  it.each([
    ['method_not_found', { ok: false, error: { code: 'method_not_found' } }, 'refused'],
    ['incompatible params', { ok: false, error: { code: 'invalid_argument' } }, 'refused'],
    ['an unknown reason', { ok: true, result: { supported: false, reason: 'later' } }, 'refused'],
    ['a dropped reply', new Error('socket closed'), 'unknown'],
    ['an empty reply', undefined, 'unknown'],
    ['a malformed verdict', { ok: true, result: { supported: 'yes' } }, 'unknown']
  ])('fails closed on %s', async (_label, reply, kind) => {
    const client = clientReturning(ADMITTED, reply)
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
    ).resolves.toMatchObject({ kind, message: expect.stringContaining('Nothing was created') })
  })

  it('never probes the repo when admission is refused or in draft mode', async () => {
    const refused = clientReturning({
      ok: true,
      result: { capabilities: [], deviceScope: 'runtime' }
    })
    await resolveWorkItemStartRoute({
      client: refused,
      settings: strict,
      agent: 'codex',
      repo: LOCAL_REPO
    })
    expect(refused.sendRequest.mock.calls.map((call) => call[0])).toEqual(['status.get'])

    const draft = clientReturning()
    await expect(
      resolveWorkItemStartRoute({
        client: draft,
        settings: { workItemStartPromptDelivery: 'draft' },
        agent: 'codex',
        repo: LOCAL_REPO
      })
    ).resolves.toEqual({ kind: 'terminal' })
    expect(draft.sendRequest).not.toHaveBeenCalled()
  })
})
