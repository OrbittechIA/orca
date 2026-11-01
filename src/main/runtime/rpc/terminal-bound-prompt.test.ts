import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../orchestration/db'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

vi.mock('../../git/worktree', () => ({
  listWorktreesStrict: async () => [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
  ]
}))

async function harness() {
  const created = await createAgentPromptSubmissionRuntime((runtime, data) => {
    if (data === '\r') {
      runtime.onPtyData(
        'pty-prompt',
        '\x1b]9999;{"state":"working","agentType":"claude"}\x07',
        Date.now()
      )
    }
  }, 'claude')
  const [pane] = (await created.runtime.listTerminals()).terminals
  const replace = (incarnationId: string) =>
    created.runtime.registerPty('pty-prompt', pane.worktreeId, null, { ...pane, incarnationId })
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
    const h = await harness()
    try {
      const first = h.dispatcher.dispatch(h.request)
      await vi.runAllTimersAsync()
      await expect(first).resolves.toMatchObject({
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
})
