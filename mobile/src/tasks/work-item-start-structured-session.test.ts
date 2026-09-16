import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { buildTaskWorkspaceCreateParams } from './workspace-create-params'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import {
  readWorkItemStartHostAdmission,
  startWorkItemStructuredSession,
  workItemStartAgentSupportsStructuredSession,
  workItemStartHostAdmitsStructuredSession,
  workItemStartRequiresStructuredSession
} from './work-item-start-structured-session'

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
    const support = client.sendRequest.mock.calls[0]?.[1] as {
      launchOrigin?: string
      sessionId?: string
    }
    expect(support.launchOrigin).toBe('work-item-start')
    const create = client.sendRequest.mock.calls[1]?.[1] as {
      launchOrigin?: string
      envelope: { sessionId: string }
    }
    expect(create.launchOrigin).toBe('work-item-start')
    // Same durable session on both halves, so a replay reconciles instead of forking a rival.
    expect(create.envelope.sessionId).toBe(support.sessionId)

    const send = client.sendRequest.mock.calls[2]?.[1] as {
      envelope: { sessionId: string; expectedRuntimeFence: number }
      body: { blocks: { type: string; text?: string }[] }
    }
    expect(client.sendRequest.mock.calls[2]?.[0]).toBe('agentSession.send')
    expect(send.envelope.sessionId).toBe('codex_session_1')
    expect(send.envelope.expectedRuntimeFence).toBe(3)
    expect(send.body.blocks).toEqual([{ type: 'text', text: GITHUB_ITEM.source.url }])
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
      result: { ok: false, refusal: { code: 'agent_session_busy', message: 'session busy' } }
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
})
