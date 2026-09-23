import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  readWorkItemStartHostAdmission,
  resolveWorkItemStartRoute,
  WORK_ITEM_START_ADMISSION_TIMEOUT_MS,
  WORK_ITEM_START_ROUTE_MESSAGES,
  workItemStartAgentSupportsStructuredSession,
  workItemStartHostAdmitsStructuredSession,
  workItemStartRequiresStructuredSession
} from './work-item-start-route'

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
  return { sendRequest } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

const SUPPORTED = { ok: true, result: { supported: true } }
const LOCAL_REPO = { id: 'repo-1', path: '/repos/orca', connectionId: null }

describe('work item start structured session policy', () => {
  it('requires a structured session exactly when the host submits after ready', () => {
    expect(workItemStartRequiresStructuredSession({})).toBe(false)
    expect(workItemStartRequiresStructuredSession(null)).toBe(false)
    expect(workItemStartRequiresStructuredSession({ workItemStartPromptDelivery: 'draft' })).toBe(
      false
    )
    expect(
      workItemStartRequiresStructuredSession({
        workItemStartPromptDelivery: 'submit-after-ready'
      })
    ).toBe(true)
  })

  it('only admits providers that carry a durable session handle', () => {
    expect(workItemStartAgentSupportsStructuredSession('codex')).toBe(true)
    expect(workItemStartAgentSupportsStructuredSession('claude')).toBe(true)
    expect(workItemStartAgentSupportsStructuredSession('gemini')).toBe(false)
    expect(workItemStartAgentSupportsStructuredSession('blank')).toBe(false)
    expect(workItemStartAgentSupportsStructuredSession(undefined)).toBe(false)
  })
})

describe('work item start host admission', () => {
  const CAP = WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY

  it('needs both the capability and a runtime-scoped pairing', () => {
    expect(
      workItemStartHostAdmitsStructuredSession({ capabilities: [CAP], deviceScope: 'runtime' })
    ).toBe(true)
    // A phone pairing is refused by the host no matter the setting, so it must keep its terminal.
    expect(
      workItemStartHostAdmitsStructuredSession({ capabilities: [CAP], deviceScope: 'mobile' })
    ).toBe(false)
    // An older host without the route would reject the create after the draft was dropped.
    expect(
      workItemStartHostAdmitsStructuredSession({ capabilities: [], deviceScope: 'runtime' })
    ).toBe(false)
    expect(workItemStartHostAdmitsStructuredSession(null)).toBe(false)
    expect(workItemStartHostAdmitsStructuredSession({ deviceScope: 'runtime' })).toBe(false)
  })

  it('reads the admission off status.get and fails to "not admitted"', async () => {
    const ok = clientReturning({
      ok: true,
      result: { capabilities: [CAP], deviceScope: 'runtime' }
    })
    await expect(readWorkItemStartHostAdmission(ok)).resolves.toEqual({
      capabilities: [CAP],
      deviceScope: 'runtime'
    })
    // One round trip, not two: this client declared its capabilities while authenticating.
    expect(ok.sendRequest).toHaveBeenCalledTimes(1)
    expect(ok.sendRequest.mock.calls[0]?.[0]).toBe('status.get')
    await expect(
      readWorkItemStartHostAdmission(clientReturning({ ok: false, error: { code: 'busy' } }))
    ).resolves.toBeNull()
    await expect(
      readWorkItemStartHostAdmission(clientReturning(new Error('socket closed')))
    ).resolves.toBeNull()
  })
})

describe('work item start route is decided before anything is created', () => {
  const strict = { workItemStartPromptDelivery: 'submit-after-ready' as const }

  it('is the terminal Start in draft mode or without an agent, without probing the host', async () => {
    const client = clientReturning()
    await expect(
      resolveWorkItemStartRoute({
        client,
        settings: { workItemStartPromptDelivery: 'draft' },
        agent: 'codex',
        repo: LOCAL_REPO
      })
    ).resolves.toEqual({ kind: 'terminal' })
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'blank', repo: LOCAL_REPO })
    ).resolves.toEqual({ kind: 'terminal' })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('is structured only when the host admits a runtime-scoped pairing with the capability', async () => {
    const client = clientReturning(
      {
        ok: true,
        result: {
          capabilities: [WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY],
          deviceScope: 'runtime'
        }
      },
      SUPPORTED
    )
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
    ).resolves.toEqual({
      kind: 'structured'
    })
    expect(client.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: WORK_ITEM_START_ADMISSION_TIMEOUT_MS
    })
  })

  it('is refused, not terminal, against an old host without the route', async () => {
    const client = clientReturning({
      ok: true,
      result: { capabilities: [], deviceScope: 'runtime' }
    })
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
    ).resolves.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('no terminal was started in its place')
    })
  })

  it('is refused, not terminal, for a pairing scoped mobile', async () => {
    const client = clientReturning({
      ok: true,
      result: {
        capabilities: [WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY],
        deviceScope: 'mobile'
      }
    })
    // A scope refusal holds on any build, so the copy names the pairing, not an old host or WSL.
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
    ).resolves.toEqual({ kind: 'refused', message: WORK_ITEM_START_ROUTE_MESSAGES.scope })
    expect(WORK_ITEM_START_ROUTE_MESSAGES.scope).toContain('mobile scope')
  })

  it('is unknown, not terminal, when the status probe times out or fails', async () => {
    for (const failure of [
      new Error('status.get timed out'),
      { ok: false, error: { code: 'runtime_busy' } }
    ]) {
      const client = clientReturning(failure)
      await expect(
        resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
      ).resolves.toMatchObject({
        kind: 'unknown',
        message: expect.stringContaining('Nothing was created')
      })
    }
  })
})

describe('strict Start refuses an unsupported execution host before anything is created', () => {
  const strict = { workItemStartPromptDelivery: 'submit-after-ready' as const }

  it.each([
    [
      'an SSH repo',
      { id: 'repo-1', path: '/srv/orca', connectionId: 'ssh-1' },
      'remote execution host'
    ],
    [
      'a runtime-hosted repo',
      { id: 'repo-1', path: '/srv/orca', executionHostId: 'runtime:environment-1' },
      'remote execution host'
    ],
    [
      'a WSL checkout',
      { id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' },
      'inside WSL'
    ]
  ])('refuses %s without asking the host anything', async (_label, repo, reason) => {
    const client = clientReturning()
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo })
    ).resolves.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining(reason)
    })
    // Zero side effects: not even the admission probe runs, let alone worktree.create.
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('matches the desktop verdict for the same repo rows', async () => {
    const { resolveStructuredNativeChatSupport } =
      await import('../../../src/shared/structured-native-chat-launch-route')
    const { getRepoExecutionHostId } = await import('../../../src/shared/execution-host')
    for (const repo of [
      { id: 'repo-1', path: '/srv/orca', connectionId: 'ssh-1' },
      { id: 'repo-1', path: '/srv/orca', executionHostId: 'runtime:environment-1' }
    ]) {
      const desktop = resolveStructuredNativeChatSupport({
        agent: 'codex',
        executionHostId: getRepoExecutionHostId(repo),
        hostCapabilities: [],
        workspaceKind: 'git-worktree',
        launchOrigin: 'work-item-start'
      })
      const mobile = await resolveWorkItemStartRoute({
        client: clientReturning(),
        settings: strict,
        agent: 'codex',
        repo
      })
      expect(desktop).toMatchObject({ supported: false, blocker: 'remote-execution-host' })
      expect(mobile.kind).toBe('refused')
    }
  })
})
