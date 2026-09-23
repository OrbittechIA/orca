import { isUnknownRecord } from '../../../src/shared/unknown-record'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
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
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  readWorkItemStartHostAdmission,
  resolveWorkItemStartRoute,
  retryWorkItemStartStructuredSession,
  startWorkItemStructuredSession,
  WORK_ITEM_START_ADMISSION_TIMEOUT_MS,
  workItemStartAgentSupportsStructuredSession,
  workItemStartHostAdmitsStructuredSession,
  workItemStartRequiresStructuredSession
} from './work-item-start-structured-session'
import { resetMobileStructuredSendOperationJournalForTests } from '../session/mobile-structured-send-operation-journal'

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

function createdSession(sessionId = 'codex_session_1', fence = 3): unknown {
  return {
    ok: true,
    result: {
      ok: true,
      replayed: false,
      fence,
      cursor: { epoch: 'epoch-1', sequence: 0 },
      value: {
        sessionId,
        fence,
        page: {
          sessionId,
          epoch: 'epoch-1',
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [],
          window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
          liveCursor: { epoch: 'epoch-1', sequence: 0 },
          hasOlder: false,
          hasNewer: false
        },
        unconfirmedClientMessageIds: []
      }
    }
  }
}

const ACCEPTED_SEND = {
  ok: true,
  result: {
    ok: true,
    value: {
      clientMessageId: 'msg-1',
      submission: { clientMessageId: 'msg-1', dispatchState: 'accepted' }
    }
  }
}

const GITHUB_ITEM = {
  provider: 'github' as const,
  source: {
    type: 'issue' as const,
    repoId: 'repo-1',
    number: 387,
    title: 'Caderno Visual-01',
    url: 'https://github.com/OrbittechIA/av1-medicina-unibh-builder/issues/387'
  }
}

function taskCreateParams(structuredStart: boolean): Record<string, unknown> {
  return buildTaskWorkspaceCreateParams({
    item: GITHUB_ITEM,
    targetRepoId: 'repo-1',
    setupDecision: 'run',
    agent: 'codex',
    structuredStart
  })
}

const SEND_JOURNAL_KEY = 'orca:mobileStructuredSendOperations:v1'
const ATTEMPT_JOURNAL_KEY = 'orca:mobileWorkItemStartAttempts:v1'
const LOCAL_REPO = { id: 'repo-1', path: '/repos/orca', connectionId: null }

/** The params of one RPC call as a record; an unexpected shape reads as empty, never as a cast. */
function paramsOf(params: unknown): Record<string, unknown> {
  return isUnknownRecord(params) ? params : {}
}

function envelopeOf(params: unknown): Record<string, unknown> {
  return paramsOf(paramsOf(params).envelope)
}

function sendEnvelopes(client: { sendRequest: ReturnType<typeof vi.fn> }) {
  return client.sendRequest.mock.calls
    .filter((call) => call[0] === 'agentSession.send')
    .map((call) => envelopeOf(call[1]))
}

describe('work item start prompt delivery is durable and replays one envelope', () => {
  beforeEach(() => {
    asyncStorage.store.clear()
    asyncStorage.setItem.mockClear()
    resetMobileStructuredSendOperationJournalForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function start(client: RpcClient) {
    const promise = startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })
    // Same-envelope replays wait between attempts; drive the clock past every delay.
    await vi.advanceTimersByTimeAsync(5_000)
    return promise
  }

  it('persists the send envelope before the first dispatch', async () => {
    const order: string[] = []
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      order.push(key === SEND_JOURNAL_KEY ? 'journal' : 'attempt')
      asyncStorage.store.set(key, value)
    })
    const client = clientReturning(SUPPORTED, createdSession())
    client.sendRequest.mockImplementation(async (method: string) => {
      if (method === 'agentSession.send') {
        order.push('send')
        return ACCEPTED_SEND
      }
      return method === 'agentSession.createSupport' ? SUPPORTED : createdSession()
    })
    await start(client)
    // The Start's identity is recorded before anything is requested, the send before it goes out.
    expect(order[0]).toBe('attempt')
    const sendIndex = order.indexOf('send')
    expect(order.slice(0, sendIndex)).toContain('journal')
    // Settled: the durable record is gone, so nothing will replay it later.
    expect(asyncStorage.store.has(SEND_JOURNAL_KEY)).toBe(false)
  })

  it('replays the same envelope when the accepted reply was lost', async () => {
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      markRpcDeliveryUnknown(new Error('reply lost after write')),
      ACCEPTED_SEND
    )
    const result = await start(client)
    expect(result).toEqual({ kind: 'started', sessionId: 'codex_session_1' })
    const envelopes = sendEnvelopes(client)
    expect(envelopes).toHaveLength(2)
    expect(envelopes[1]).toEqual(envelopes[0])
    expect(asyncStorage.store.has(SEND_JOURNAL_KEY)).toBe(false)
  })

  it('treats agent_session_operation_unknown as unknown and replays the same operation id', async () => {
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_operation_unknown', message: 'ledger unknown' }
        }
      },
      ACCEPTED_SEND
    )
    const result = await start(client)
    expect(result).toEqual({ kind: 'started', sessionId: 'codex_session_1' })
    const envelopes = sendEnvelopes(client)
    expect(envelopes).toHaveLength(2)
    expect(envelopes[1]?.clientOperationId).toBe(envelopes[0]?.clientOperationId)
  })

  it('keeps the envelope persisted and names it when every replay stays unknown', async () => {
    const lost = () => markRpcDeliveryUnknown(new Error('reply lost'))
    const client = clientReturning(SUPPORTED, createdSession(), lost(), lost(), lost(), lost())
    const result = await start(client)
    const envelopes = sendEnvelopes(client)
    // One operation id across every attempt; a bounded number of attempts.
    expect(new Set(envelopes.map((envelope) => envelope.clientOperationId)).size).toBe(1)
    expect(envelopes).toHaveLength(3)
    expect(result).toMatchObject({
      kind: 'unconfirmed',
      sessionId: 'codex_session_1',
      pendingSend: { clientOperationId: envelopes[0]?.clientOperationId, fence: 3 }
    })
    expect(asyncStorage.store.get(SEND_JOURNAL_KEY)).toContain(envelopes[0]?.clientOperationId)
  })

  it('keeps M1 persisted through a pending-admission refusal and never mints M2', async () => {
    // Reviewer counterexample: the first reply is lost after the host may have committed M1;
    // the same-id replay is refused with `agent_session_operation_capacity` ("try later").
    // That is pending-admission, not a settlement: M1 may be in provider context, so the
    // journal keeps it and the Start reports unconfirmed with the exact envelope.
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      markRpcDeliveryUnknown(new Error('reply lost after write')),
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_operation_capacity', message: 'try later' }
        }
      },
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_operation_capacity', message: 'try later' }
        }
      }
    )
    const result = await start(client)
    const envelopes = sendEnvelopes(client)
    expect(envelopes).toHaveLength(3)
    expect(new Set(envelopes.map((envelope) => envelope.clientOperationId)).size).toBe(1)
    expect(result).toMatchObject({
      kind: 'unconfirmed',
      sessionId: 'codex_session_1',
      pendingSend: { clientOperationId: envelopes[0]?.clientOperationId, fence: 3 }
    })
    expect(asyncStorage.store.get(SEND_JOURNAL_KEY)).toContain(envelopes[0]?.clientOperationId)
  })

  it.each([
    'agent_session_operation_capacity',
    'agent_session_ownership_unknown',
    'execution_owner_reconciling',
    'agent_session_journal_unreadable'
  ])('replays the same id after a %s refusal instead of clearing M1', async (code) => {
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      { ok: true, result: { ok: false, refusal: { code, message: 'not settled' } } },
      ACCEPTED_SEND
    )
    const result = await start(client)
    expect(result).toEqual({ kind: 'started', sessionId: 'codex_session_1' })
    const envelopes = sendEnvelopes(client)
    expect(envelopes).toHaveLength(2)
    expect(envelopes[1]?.clientOperationId).toBe(envelopes[0]?.clientOperationId)
    expect(asyncStorage.store.has(SEND_JOURNAL_KEY)).toBe(false)
  })

  it.each([
    'agent_session_operation_conflict',
    'agent_session_operation_expired',
    'agent_session_already_resolved'
  ])('clears M1 only for a genuinely settled %s rejection', async (code) => {
    const client = clientReturning(SUPPORTED, createdSession(), {
      ok: true,
      result: { ok: false, refusal: { code, message: 'settled' } }
    })
    const result = await start(client)
    expect(result.kind).toBe('prompt-undelivered')
    expect(sendEnvelopes(client)).toHaveLength(1)
    expect(asyncStorage.store.has(SEND_JOURNAL_KEY)).toBe(false)
  })

  it('never mints a second operation for a definitive refusal', async () => {
    const client = clientReturning(SUPPORTED, createdSession(), {
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_operation_conflict', message: 'no' } }
    })
    const result = await start(client)
    expect(result.kind).toBe('prompt-undelivered')
    expect(sendEnvelopes(client)).toHaveLength(1)
    expect(asyncStorage.store.has(SEND_JOURNAL_KEY)).toBe(false)
  })
})

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
    await expect(
      resolveWorkItemStartRoute({ client, settings: strict, agent: 'codex', repo: LOCAL_REPO })
    ).resolves.toMatchObject({
      kind: 'refused'
    })
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

describe('work item start workspace create params', () => {
  // The defect this pins: the task Start seeded a terminal with the issue URL, and that pane was
  // the only "agent" the run ever had — carrying no session identity at all.
  it('omits the terminal draft startup when the session owns the first surface', () => {
    const params = taskCreateParams(true)
    expect(params.startupDraft).toBeUndefined()
    // Ownership and removal safety still have to see the agent that will write here.
    expect(params.createdWithAgent).toBe('codex')
    expect(params.linkedIssue).toBe(387)
  })

  it('keeps the draft-mode terminal startup untouched', () => {
    const params = taskCreateParams(false)
    expect(params.startupDraft).toBe(GITHUB_ITEM.source.url)
    expect(params.createdWithAgent).toBe('codex')
  })
})

describe('startWorkItemStructuredSession', () => {
  it('creates the scoped session and delivers its single prompt once', async () => {
    const client = clientReturning(SUPPORTED, createdSession(), ACCEPTED_SEND)

    await expect(
      startWorkItemStructuredSession({
        client,
        worktreeId: 'workspace-1',
        agent: 'codex',
        prompt: GITHUB_ITEM.source.url
      })
    ).resolves.toEqual({ kind: 'started', sessionId: 'codex_session_1' })

    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    const support = paramsOf(client.sendRequest.mock.calls[0]?.[1])
    expect(support.launchOrigin).toBe('work-item-start')
    const create = paramsOf(client.sendRequest.mock.calls[1]?.[1])
    expect(create.launchOrigin).toBe('work-item-start')
    // Same durable session on both halves, so a replay reconciles instead of forking a rival.
    expect(envelopeOf(create).sessionId).toBe(support.sessionId)

    const send = client.sendRequest.mock.calls[2]?.[1]
    expect(client.sendRequest.mock.calls[2]?.[0]).toBe('agentSession.send')
    expect(envelopeOf(send).sessionId).toBe('codex_session_1')
    expect(envelopeOf(send).expectedRuntimeFence).toBe(3)
    expect(paramsOf(paramsOf(send).body).blocks).toEqual([
      { type: 'text', text: GITHUB_ITEM.source.url }
    ])
  })

  it('refuses without starting anything when the host declines the session', async () => {
    const client = clientReturning({ ok: true, result: { supported: false, reason: 'remote' } })

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result.kind).toBe('refused')
    // No create, and above all no terminal fallback: a second writer is the worse failure.
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses a provider without a structured session before touching the host', async () => {
    const client = clientReturning()

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'gemini',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result.kind).toBe('refused')
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('leaves an unconfirmed create unconfirmed and sends no prompt', async () => {
    const client = clientReturning(
      SUPPORTED,
      markRpcDeliveryUnknown(new Error('connection lost')),
      markRpcDeliveryUnknown(new Error('connection lost'))
    )

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result.kind).toBe('unconfirmed')
    // support + create + the single durable replay, and nothing after it.
    expect(client.sendRequest).toHaveBeenCalledTimes(3)
    expect(client.sendRequest.mock.calls.some((call) => call[0] === 'agentSession.send')).toBe(
      false
    )
  })

  it('will not guess a fence when the host answered without one', async () => {
    const client = clientReturning(SUPPORTED, {
      ok: true,
      result: { ok: true, value: { sessionId: 'codex_session_1' } }
    })

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result).toMatchObject({ kind: 'prompt-undelivered', sessionId: 'codex_session_1' })
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('treats a rejected dispatch as an undelivered prompt, not a start', async () => {
    const client = clientReturning(SUPPORTED, createdSession(), {
      ok: true,
      result: {
        ok: true,
        value: {
          clientMessageId: 'msg-1',
          submission: { dispatchState: 'rejected', reason: 'provider refused the turn' }
        }
      }
    })

    await expect(
      startWorkItemStructuredSession({
        client,
        worktreeId: 'workspace-1',
        agent: 'codex',
        prompt: GITHUB_ITEM.source.url
      })
    ).resolves.toEqual({
      kind: 'prompt-undelivered',
      sessionId: 'codex_session_1',
      message: 'provider refused the turn'
    })
  })

  it('leaves a pending or unknown dispatch unconfirmed', async () => {
    for (const dispatchState of ['pending', 'unknown']) {
      const client = clientReturning(SUPPORTED, createdSession(), {
        ok: true,
        result: {
          ok: true,
          value: { clientMessageId: 'msg-1', submission: { dispatchState } }
        }
      })
      const result = await startWorkItemStructuredSession({
        client,
        worktreeId: 'workspace-1',
        agent: 'codex',
        prompt: GITHUB_ITEM.source.url
      })
      expect(result.kind).toBe('unconfirmed')
    }
  })

  it('a probe that never reached the host is unconfirmed, not a refusal', async () => {
    const client = clientReturning({ ok: false, error: { code: 'runtime_busy' } })

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result.kind).toBe('unconfirmed')
    expect(client.sendRequest).toHaveBeenCalledTimes(1)
  })

  it('explains a host refusal in words rather than a raw reason token', async () => {
    const client = clientReturning({ ok: true, result: { supported: false, reason: 'remote' } })

    const result = await startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })

    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.message).toContain('remote execution host')
  })

  it('reports an undelivered prompt against the session that does exist', async () => {
    const client = clientReturning(SUPPORTED, createdSession(), {
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'agent_session_operation_conflict', message: 'session busy' }
      }
    })

    await expect(
      startWorkItemStructuredSession({
        client,
        worktreeId: 'workspace-1',
        agent: 'codex',
        prompt: GITHUB_ITEM.source.url
      })
    ).resolves.toEqual({
      kind: 'prompt-undelivered',
      sessionId: 'codex_session_1',
      message: 'session busy'
    })
  })

  it('keeps M1 for a refusal code the ledger does not classify as settled', async () => {
    // Fail closed: an unknown code proves nothing about M1, so it is replayed under the same id
    // and, still undecided, reported unconfirmed with the envelope retained.
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      { ok: true, result: { ok: false, refusal: { code: 'agent_session_busy', message: 'busy' } } },
      { ok: true, result: { ok: false, refusal: { code: 'agent_session_busy', message: 'busy' } } },
      { ok: true, result: { ok: false, refusal: { code: 'agent_session_busy', message: 'busy' } } }
    )
    const promise = startWorkItemStructuredSession({
      client,
      worktreeId: 'workspace-1',
      agent: 'codex',
      prompt: GITHUB_ITEM.source.url
    })
    const result = await promise
    expect(result).toMatchObject({ kind: 'unconfirmed', sessionId: 'codex_session_1' })
    expect(
      new Set(
        client.sendRequest.mock.calls
          .filter((call) => call[0] === 'agentSession.send')
          .map((call) => envelopeOf(call[1]).clientOperationId)
      ).size
    ).toBe(1)
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

describe('a strict Start retry re-enters the same workspace, session and operations', () => {
  beforeEach(() => {
    asyncStorage.store.clear()
    resetMobileStructuredSendOperationJournalForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(30_000)
    return promise
  }

  function calls(client: { sendRequest: ReturnType<typeof vi.fn> }, method: string) {
    return client.sendRequest.mock.calls.filter((call) => call[0] === method)
  }

  function sessionIdsOf(client: { sendRequest: ReturnType<typeof vi.fn> }): Set<unknown> {
    return new Set([
      ...calls(client, 'agentSession.createSupport').map((call) => paramsOf(call[1]).sessionId),
      ...calls(client, 'agentSession.create').map((call) => envelopeOf(call[1]).sessionId)
    ])
  }

  function startFirst(client: RpcClient) {
    return settle(
      startWorkItemStructuredSession({
        client,
        worktreeId: 'workspace-1',
        worktreeName: 'issue-387',
        agent: 'codex',
        prompt: GITHUB_ITEM.source.url
      })
    )
  }

  it('reconciles an unknown create with the recorded session instead of minting one', async () => {
    const lost = markRpcDeliveryUnknown(new Error('create reply lost'))
    const client = clientReturning(SUPPORTED, lost, lost)
    const first = await startFirst(client)
    expect(first).toMatchObject({ kind: 'unconfirmed' })
    expect(asyncStorage.store.has(ATTEMPT_JOURNAL_KEY)).toBe(true)

    const recordedSessionId = 'sessionId' in first ? first.sessionId : undefined
    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'agentSession.createSupport'
        ? SUPPORTED
        : method === 'agentSession.create'
          ? createdSession(recordedSessionId)
          : ACCEPTED_SEND
    )
    const retried = await settle(
      retryWorkItemStartStructuredSession({ client, worktreeId: 'workspace-1' })
    )

    expect(retried).toEqual({ kind: 'started', sessionId: recordedSessionId })
    // One session identity and one create operation across the first attempt and the retry.
    expect(sessionIdsOf(client)).toEqual(new Set([recordedSessionId]))
    const createOperations = new Set(
      calls(client, 'agentSession.create').map((call) => envelopeOf(call[1]).clientOperationId)
    )
    expect(createOperations.size).toBe(1)
    expect(calls(client, 'worktree.create')).toHaveLength(0)
    expect(calls(client, 'agentSession.send')).toHaveLength(1)
    // Settled: nothing is left for another retry to re-enter.
    await expect(
      retryWorkItemStartStructuredSession({ client, worktreeId: 'workspace-1' })
    ).resolves.toBeNull()
  })

  it('replays the same send operation after an unconfirmed delivery', async () => {
    const unknownSend = markRpcDeliveryUnknown(new Error('send reply lost'))
    const client = clientReturning(
      SUPPORTED,
      createdSession(),
      unknownSend,
      unknownSend,
      unknownSend
    )
    const first = await startFirst(client)
    expect(first).toMatchObject({ kind: 'unconfirmed', sessionId: 'codex_session_1' })

    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'agentSession.createSupport'
        ? SUPPORTED
        : method === 'agentSession.create'
          ? createdSession()
          : ACCEPTED_SEND
    )
    const retried = await settle(
      retryWorkItemStartStructuredSession({ client, worktreeId: 'workspace-1' })
    )

    expect(retried).toEqual({ kind: 'started', sessionId: 'codex_session_1' })
    const sendOperations = new Set(
      sendEnvelopes(client).map((envelope) => envelope.clientOperationId)
    )
    expect(sendOperations.size).toBe(1)
    expect(sessionIdsOf(client).size).toBe(1)
  })

  it('keeps the session identity when the support probe went unanswered', async () => {
    const client = clientReturning(new Error('socket closed'))
    const first = await startFirst(client)
    expect(first).toMatchObject({ kind: 'unconfirmed' })
    const firstSessionId = paramsOf(calls(client, 'agentSession.createSupport')[0]?.[1]).sessionId

    client.sendRequest.mockImplementation(async (method: string) =>
      method === 'agentSession.createSupport'
        ? SUPPORTED
        : method === 'agentSession.create'
          ? createdSession(String(firstSessionId))
          : ACCEPTED_SEND
    )
    await expect(
      settle(retryWorkItemStartStructuredSession({ client, worktreeId: 'workspace-1' }))
    ).resolves.toMatchObject({ kind: 'started' })
    expect(sessionIdsOf(client)).toEqual(new Set([firstSessionId]))
  })

  it('releases the identity after a definitive refusal, so no retry re-enters it', async () => {
    const client = clientReturning({ ok: true, result: { supported: false, reason: 'remote' } })
    await expect(startFirst(client)).resolves.toMatchObject({ kind: 'refused' })
    await expect(
      retryWorkItemStartStructuredSession({ client, worktreeId: 'workspace-1' })
    ).resolves.toBeNull()
  })
})
