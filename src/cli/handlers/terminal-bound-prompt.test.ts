import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { TERMINAL_BOUND_PROMPT_RUNTIME_CAPABILITY } from '../../shared/terminal-runtime-capabilities'
import { terminalSendHandler } from './terminal-send'

function client(capable: boolean, runtimeId = 'runtime-original') {
  const c = new RuntimeClient('/tmp/bound-prompt-test', 60_000, null, null)
  vi.spyOn(c, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: true, pid: 123 },
      graph: { state: 'ready' },
      runtime: {
        reachable: true,
        state: 'ready',
        runtimeId,
        capabilities: [
          TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
          ...(capable ? [TERMINAL_BOUND_PROMPT_RUNTIME_CAPABILITY] : [])
        ]
      }
    },
    _meta: { runtimeId }
  })
  const call = vi.spyOn(c, 'call').mockResolvedValue({
    id: 'send',
    ok: true,
    result: { send: { handle: 'term-one', accepted: false, bytesWritten: 0 } },
    _meta: { runtimeId }
  })
  return { c, call }
}

function flags() {
  return new Map<string, string | true>([
    ['terminal', 'term-one'],
    ['text', 'one attention'],
    ['enter', true],
    ['expected-incarnation', 'inc-original'],
    ['expected-runtime', 'runtime-original']
  ])
}

describe('conditional terminal prompt CLI', () => {
  const originalExit = process.exitCode
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExit
  })

  it('refuses an older host before any send RPC, without stripping the conditions', async () => {
    const { c, call } = client(false)
    await expect(
      terminalSendHandler({ flags: flags(), client: c, cwd: '/tmp', json: true })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a changed runtime before any send RPC', async () => {
    const { c, call } = client(true, 'runtime-replacement')
    await expect(
      terminalSendHandler({ flags: flags(), client: c, cwd: '/tmp', json: true })
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects incomplete conditions and raw input before transport', async () => {
    for (const missing of ['expected-runtime', 'expected-incarnation', 'enter']) {
      const { c, call } = client(true)
      const f = flags()
      f.delete(missing)
      await expect(
        terminalSendHandler({ flags: f, client: c, cwd: '/tmp', json: true })
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  })

  it('uses a distinct public RPC so even a host downgrade cannot reinterpret it as an ordinary send', async () => {
    const { c, call } = client(true)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await terminalSendHandler({ flags: flags(), client: c, cwd: '/tmp', json: true })
    expect(call).toHaveBeenCalledWith(
      'terminal.sendBoundPrompt',
      expect.objectContaining({
        expectedIncarnationId: 'inc-original',
        expectedRuntimeId: 'runtime-original',
        agentPrompt: true,
        enter: true
      }),
      expect.objectContaining({ terminalPromptPreflight: { runtimeId: 'runtime-original' } })
    )
  })
})
