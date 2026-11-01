import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../orchestration/db'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { OrcaRuntimeService } from '../orca-runtime'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import type {
  AgentPromptActivity,
  AgentPromptWaitTextCache
} from '../agent-prompt-submission-verification'

class RetryBoundaryRuntime extends OrcaRuntimeService {
  replaceAfterActivityRead: (() => void) | null = null

  protected override getAgentPromptActivity(
    handle: string,
    ptyId: string,
    waitTextCache?: AgentPromptWaitTextCache
  ): AgentPromptActivity {
    const activity = super.getAgentPromptActivity(handle, ptyId, waitTextCache)
    const replace = this.replaceAfterActivityRead
    this.replaceAfterActivityRead = null
    if (replace) {
      queueMicrotask(replace)
    }
    return activity
  }
}

vi.mock('../../git/worktree', () => ({
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

async function harness(provenForeground = false) {
  const created = await createAgentPromptSubmissionRuntime(
    (runtime, data) => {
      if (data === '\r') {
        runtime.onPtyData(
          'pty-prompt',
          '\x1b]9999;{"state":"working","agentType":"claude"}\x07',
          Date.now()
        )
      }
    },
    'claude',
    provenForeground ? () => true : undefined
  )
  const [pane] = (await created.runtime.listTerminals()).terminals
  const replace = (incarnationId: string) =>
    created.runtime.registerPty('pty-prompt', pane.worktreeId, null, {
      ...pane,
      incarnationId,
      terminalHandle: created.handle
    })
  replace('inc-original')
  const db = new OrchestrationDb(':memory:')
  created.runtime.setOrchestrationDb(db)
  const dispatcher = new RpcDispatcher({ runtime: created.runtime, methods: TERMINAL_METHODS })
  const request = {
    id: 'bound-rpc',
    authToken: 'test',
    method: 'terminal.sendBoundPrompt',
    orchestrationRequestId: 'bound-request',
    params: {
      terminal: created.handle,
      text: 'one authorized attention',
      enter: true,
      agentPrompt: true,
      waitSubmitMs: 1_000,
      expectedRuntimeId: created.runtime.getRuntimeId(),
      expectedIncarnationId: 'inc-original',
      client: { id: 'orca-cli', type: 'desktop' }
    }
  }
  return { ...created, dispatcher, db, replace, request }
}

describe('terminal.sendBoundPrompt', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('refuses a replacement between the caller snapshot and RPC without writing bytes', async () => {
    const h = await harness()
    try {
      h.replace('inc-replacement')
      const response = await h.dispatcher.dispatch(h.request)
      expect(response).toMatchObject({
        ok: true,
        result: { send: { accepted: false, bytesWritten: 0 } }
      })
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('refuses replacement while admission awaits agent readiness, before the first paste', async () => {
    const h = await harness()
    try {
      vi.spyOn(h.runtime, 'isTerminalRunningSettledPromptAgent').mockImplementation(async () => {
        h.replace('inc-replacement')
        return true
      })
      const response = await h.dispatcher.dispatch(h.request)
      expect(response.ok).toBe(false)
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('refuses an unexpected runtime without touching the terminal', async () => {
    const h = await harness()
    try {
      const response = await h.dispatcher.dispatch({
        ...h.request,
        params: { ...h.request.params, expectedRuntimeId: 'another-runtime' }
      })
      expect(response).toMatchObject({
        ok: true,
        result: { send: { accepted: false, bytesWritten: 0 } }
      })
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('does not fall back to a raw shell write when the settlement agent is unsupported', async () => {
    const h = await harness()
    try {
      vi.spyOn(h.runtime, 'isTerminalRunningSettledPromptAgent').mockResolvedValue(false)
      const response = await h.dispatcher.dispatch(h.request)
      expect(response).toMatchObject({
        ok: true,
        result: { send: { accepted: false, bytesWritten: 0 } }
      })
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('preserves native turn-start proof and observes the same request without a second input', async () => {
    vi.useFakeTimers()
    const h = await harness(true)
    try {
      expect(await h.runtime.isTerminalRunningSettledPromptAgent(h.handle)).toBe(true)
      const first = h.dispatcher.dispatch(h.request)
      await vi.runAllTimersAsync()
      const response = await first
      expect(response, JSON.stringify(response)).toMatchObject({
        ok: true,
        result: {
          send: {
            accepted: true,
            prompt: {
              requestId: 'bound-request',
              processIncarnation: 'inc-original',
              stages: ['input_accepted', 'turn_started']
            }
          }
        }
      })
      const writes = h.writes.slice()
      const replay = h.dispatcher.dispatch({ ...h.request, id: 'replay' })
      await vi.runAllTimersAsync()
      await expect(replay).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(h.writes).toEqual(writes)
      expect(h.writes.filter((data) => data === '\r')).toHaveLength(1)
    } finally {
      h.db.close()
    }
  })

  it('requires both caller conditions and a complete prompt shape at the public boundary', async () => {
    const h = await harness()
    try {
      const response = await h.dispatcher.dispatch({
        ...h.request,
        params: { terminal: h.handle, text: 'no conditions', enter: true }
      })
      expect(response.ok).toBe(false)
      expect(h.writes).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('writes no retry Enter to a process replaced during the final settled-check await', async () => {
    vi.useFakeTimers()
    // SAFETY: use the same minimal persistence fixture as the shared prompt runtime harness.
    const runtime = new RetryBoundaryRuntime(makeStore() as never)
    const writes: string[] = []
    const replacementWrites: string[] = []
    let replaced = false
    runtime.setPtyController({
      spawn: async () => ({ id: 'pty-retry' }),
      write: (_id, data) => {
        writes.push(data)
        if (replaced) {
          replacementWrites.push(data)
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const terminal = await runtime.createTerminal('path:/tmp/worktree-a', { launchAgent: 'codex' })
    const [pane] = (await runtime.listTerminals()).terminals
    const replace = (incarnationId: string) =>
      runtime.registerPty('pty-retry', pane.worktreeId, null, {
        ...pane,
        incarnationId,
        terminalHandle: terminal.handle
      })
    replace('inc-original')
    const admitted = runtime.getTerminalPromptRequestBinding(terminal.handle)
    let checks = 0
    const result = runtime
      .sendTerminalAgentPrompt(terminal.handle, 'preserve this admitted prompt', {
        inputKind: 'driving',
        composerReady: true,
        expectedBinding: admitted,
        acceptQueued: true,
        requestId: 'retry-boundary',
        observationTimeoutMs: 0,
        beforeWrite: () => {
          if (++checks === 3) {
            runtime.replaceAfterActivityRead = () => {
              replace('inc-replacement')
              replaced = true
            }
          }
        }
      })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    await result
    expect(checks).toBeGreaterThanOrEqual(3)
    expect(replaced).toBe(true)
    expect(runtime.getTerminalPromptRequestBinding(terminal.handle).processIncarnation).toBe(
      'inc-replacement'
    )
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    expect(replacementWrites).toEqual([])
  })
})
