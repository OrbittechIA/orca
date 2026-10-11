// `request-show` is the recovery path a lost mutation response sends you down, so it must
// stay read-only, render the honest reading, and name a version gap instead of a raw RPC error.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const callMock = vi.fn()

function resolveRequestShow(result: unknown): void {
  callMock.mockResolvedValue({ id: 'rpc_show', ok: true, result, _meta: { runtimeId: 'runtime' } })
}

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { getTerminalHandle } from '../selectors'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'

async function runRequestShow(
  entries: [string, string | boolean][] = [['request', 'request_1']]
): Promise<void> {
  const client = new RuntimeClient(
    join(tmpdir(), 'core79-request-show-fixture'),
    1,
    null,
    null,
    'orca'
  )
  vi.spyOn(client, 'call').mockImplementation(callMock)
  await ORCHESTRATION_HANDLERS['orchestration request-show']({
    flags: new Map<string, string | boolean>(entries),
    client,
    cwd: '/tmp/repo',
    json: false
  })
}

describe('orchestration request-show', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    vi.mocked(getTerminalHandle).mockClear()
  })

  it('asks the runtime without sending a mutation request id', async () => {
    resolveRequestShow({ requestId: 'request_1', state: 'absent', interpretation: 'none' })

    await runRequestShow()

    expect(callMock).toHaveBeenCalledWith('orchestration.requestShow', { request: 'request_1' })
  })

  it('renders the state and the honest reading of it', async () => {
    const result = {
      requestId: 'request_1',
      state: 'completed',
      method: 'orchestration.workerStart',
      interpretation: 'Request request_1 already took effect.'
    }
    resolveRequestShow(result)

    await runRequestShow()

    const [response, , render] = vi.mocked(printResult).mock.calls[0]
    expect(response).toMatchObject({ ok: true, result })
    expect(render(response.result)).toBe(
      'request_1 [completed] orchestration.workerStart\nRequest request_1 already took effect.'
    )
  })

  it('names the version gap when the server predates the command', async () => {
    callMock.mockRejectedValue(
      new RuntimeClientError('method_not_found', 'Unknown method: orchestration.requestShow')
    )

    await expect(runRequestShow()).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('Update Orca on the server')
    })
  })

  it('sends a read-only complete-hash lookup and preserves native filters', async () => {
    const payloadHash = `${'a'.repeat(64)}:${'b'.repeat(64)}`
    resolveRequestShow({
      lookup: { version: 1, outcome: 'zero' },
      interpretation: 'ambiguous'
    })
    await runRequestShow([
      ['method', 'terminal.send'],
      ['payload-hash', payloadHash],
      ['terminal', 'term_original'],
      ['process-incarnation', 'inc_1'],
      ['generation', '0'],
      ['provider', 'codex'],
      ['current-terminal', 'term_current'],
      ['provider-session', 'session_1']
    ])
    expect(callMock).toHaveBeenCalledExactlyOnceWith('orchestration.requestShow', {
      method: 'terminal.send',
      payloadHash,
      prompt: {
        terminal: 'term_original',
        processIncarnation: 'inc_1',
        generation: 0,
        provider: 'codex'
      },
      currentTerminal: 'term_current',
      providerSessionId: 'session_1'
    })
  })

  it('rejects a pending fingerprint before calling the host', async () => {
    await expect(
      runRequestShow([
        ['method', 'terminal.send'],
        ['payload-hash', 'f'.repeat(64)]
      ])
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('fails closed when an older request-show host cannot parse lookup selectors', async () => {
    callMock.mockRejectedValue(new RuntimeClientError('invalid_argument', 'Missing --request'))
    await expect(
      runRequestShow([
        ['method', 'terminal.send'],
        ['payload-hash', `${'a'.repeat(64)}:${'b'.repeat(64)}`]
      ])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
  })

  it('does not treat silently stripped current-binding fields as evidence', async () => {
    resolveRequestShow({
      requestId: 'request_1',
      state: 'completed',
      interpretation: 'historical'
    })
    await expect(
      runRequestShow([
        ['request', 'request_1'],
        ['current-terminal', 'term_current']
      ])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
  })

  it('renders a matched receipt and separate current evidence from the real RPC envelope', async () => {
    const match = {
      requestId: 'original',
      state: 'completed',
      interpretation: 'historical receipt',
      currentBinding: { state: 'mismatch', reason: 'provider changed' }
    }
    resolveRequestShow({
      lookup: { version: 1, outcome: 'matched' },
      match,
      interpretation: 'not settlement'
    })
    await runRequestShow([
      ['method', 'terminal.send'],
      ['payload-hash', `${'a'.repeat(64)}:${'b'.repeat(64)}`],
      ['current-terminal', 'term_current']
    ])
    const [response, , render] = vi.mocked(printResult).mock.calls[0]
    expect(response).toMatchObject({ ok: true, result: { match } })
    expect(render(response.result)).toBe(
      '[matched]\nnot settlement\noriginal [completed]\nhistorical receipt\nCurrent binding: mismatch — provider changed'
    )
    expect(callMock).toHaveBeenCalledOnce()
  })

  it.each([
    { requestId: 'original', state: 'completed', interpretation: 'old response' },
    { lookup: { version: 0, outcome: 'zero' }, interpretation: 'old version' },
    { lookup: { version: 1, outcome: 'matched' }, interpretation: 'missing match' },
    {
      lookup: { version: 1, outcome: 'matched' },
      match: { requestId: 'original', state: 'completed', interpretation: 'historical only' },
      interpretation: 'missing requested binding'
    }
  ])('rejects incomplete lookup evidence without another RPC call: %j', async (result) => {
    resolveRequestShow(result)
    await expect(
      runRequestShow([
        ['method', 'terminal.send'],
        ['payload-hash', `${'a'.repeat(64)}:${'b'.repeat(64)}`],
        ['current-terminal', 'term_current']
      ])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
  })

  it('preserves a real authorization refusal without retry or fallback', async () => {
    callMock.mockRejectedValue(new RuntimeClientError('forbidden', 'caller denied'))
    await expect(
      runRequestShow([
        ['method', 'terminal.send'],
        ['payload-hash', `${'a'.repeat(64)}:${'b'.repeat(64)}`]
      ])
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(callMock).toHaveBeenCalledOnce()
  })
})

const HISTORICAL_BASE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const HISTORICAL_HASH = `${HISTORICAL_BASE}:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210`
const BASE_FLAGS: [string, string | boolean][] = [
  ['method', 'terminal.send'],
  ['payload-base-hash', HISTORICAL_BASE],
  ['terminal', 'term_original'],
  ['process-incarnation', 'inc_1']
]
const historicalMatch = {
  requestId: 'historical_request',
  state: 'completed',
  method: 'terminal.send',
  payloadHash: HISTORICAL_HASH,
  createdAt: '2026-10-10 01:02:03',
  updatedAt: '2026-10-10 01:02:04',
  receipt: {
    send: {
      handle: 'term_original',
      prompt: {
        ptyId: 'historical_pty',
        processIncarnation: 'inc_1',
        generation: 0,
        provider: 'codex'
      }
    }
  },
  interpretation: 'historical receipt'
}

function baseResult(
  outcome: 'matched' | 'zero' | 'multiple' = 'matched',
  match: unknown = historicalMatch
) {
  return {
    lookup: { version: 1, outcome, payloadBaseHash: HISTORICAL_BASE },
    ...(outcome === 'matched' ? { match } : {}),
    interpretation: 'Historical evidence; no recovery authorization.'
  }
}

describe('historical base-hash request-show', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    vi.mocked(getTerminalHandle).mockClear()
  })

  it('passes only known historical filters in one read RPC and renders the stored full hash receipt', async () => {
    resolveRequestShow(baseResult())
    await runRequestShow([...BASE_FLAGS, ['generation', '0'], ['provider', 'codex']])
    expect(callMock).toHaveBeenCalledExactlyOnceWith('orchestration.requestShow', {
      method: 'terminal.send',
      payloadBaseHash: HISTORICAL_BASE,
      prompt: {
        terminal: 'term_original',
        processIncarnation: 'inc_1',
        generation: 0,
        provider: 'codex'
      }
    })
    expect(getTerminalHandle).not.toHaveBeenCalled()
    const [response, , render] = vi.mocked(printResult).mock.calls[0]
    expect(response.result).toMatchObject({ match: historicalMatch })
    expect(render(response.result)).toContain('historical_request [completed] terminal.send')
  })

  it.each(['zero', 'multiple'] as const)(
    'requires acknowledged %s evidence without inferring a generation',
    async (outcome) => {
      resolveRequestShow(baseResult(outcome))
      await runRequestShow(BASE_FLAGS)
      expect(callMock).toHaveBeenCalledOnce()
      expect(callMock.mock.calls[0][0]).toBe('orchestration.requestShow')
      expect(callMock.mock.calls[0][1].prompt.generation).toBeUndefined()
      expect(callMock.mock.calls[0][1].prompt.provider).toBeUndefined()
      expect(getTerminalHandle).not.toHaveBeenCalled()
    }
  )

  it.each([
    { 'payload-base-hash': HISTORICAL_BASE.slice(1) },
    { 'payload-base-hash': `${HISTORICAL_BASE}0` },
    { 'payload-base-hash': HISTORICAL_BASE.toUpperCase() },
    { 'payload-base-hash': `${HISTORICAL_BASE.slice(1)}%` },
    { 'payload-base-hash': `${HISTORICAL_BASE}\n` },
    { 'payload-base-hash': undefined },
    { request: 'request_1' },
    { 'payload-hash': HISTORICAL_HASH },
    { method: undefined },
    { method: 'terminal.create' },
    { terminal: undefined },
    { terminal: '' },
    { 'process-incarnation': undefined },
    { 'process-incarnation': '' },
    { 'provider-session': 'session_1' },
    { generation: '-1' },
    { provider: 'unknown' }
  ])('rejects invalid selectors before any RPC: %j', async (changes) => {
    const flags = new Map(BASE_FLAGS)
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) {
        flags.delete(key)
      } else {
        flags.set(key, value)
      }
    }
    await expect(runRequestShow([...flags])).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
    expect(getTerminalHandle).not.toHaveBeenCalled()
  })

  it.each([
    { ...historicalMatch, requestId: '' },
    { ...historicalMatch, state: 'absent' },
    { ...historicalMatch, method: 'orchestration.send' },
    { ...historicalMatch, payloadHash: undefined },
    { ...historicalMatch, payloadHash: HISTORICAL_BASE },
    { ...historicalMatch, payloadHash: `${HISTORICAL_HASH}\n` },
    { ...historicalMatch, payloadHash: HISTORICAL_HASH.toUpperCase() },
    { ...historicalMatch, payloadHash: `f${HISTORICAL_HASH.slice(1)}` },
    { ...historicalMatch, createdAt: undefined },
    { ...historicalMatch, updatedAt: undefined },
    { ...historicalMatch, receipt: undefined },
    {
      ...historicalMatch,
      receipt: { send: { handle: 'term_other', prompt: historicalMatch.receipt.send.prompt } }
    },
    {
      ...historicalMatch,
      receipt: { send: { handle: 'term_original', prompt: { processIncarnation: 'inc_other' } } }
    }
  ])('refuses incomplete or differently correlated matches with one call: %j', async (match) => {
    resolveRequestShow(baseResult('matched', match))
    await expect(runRequestShow(BASE_FLAGS)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
    expect(printResult).not.toHaveBeenCalled()
    expect(getTerminalHandle).not.toHaveBeenCalled()
  })

  it.each([
    { lookup: { version: 1, outcome: 'zero' }, interpretation: 'silently ignored selector' },
    {
      lookup: { version: 1, outcome: 'matched' },
      match: historicalMatch,
      interpretation: 'old host'
    },
    {
      ...baseResult(),
      lookup: { version: 1, outcome: 'matched', payloadBaseHash: 'f'.repeat(64) }
    },
    { ...baseResult(), match: undefined },
    { ...baseResult('zero'), match: historicalMatch },
    {
      ...baseResult(),
      lookup: { version: 2, outcome: 'matched', payloadBaseHash: HISTORICAL_BASE }
    },
    {
      ...baseResult(),
      lookup: { version: 1, outcome: 'unknown', payloadBaseHash: HISTORICAL_BASE }
    }
  ])('rejects unsupported or contradictory base evidence without fallback: %j', async (result) => {
    resolveRequestShow(result)
    await expect(runRequestShow(BASE_FLAGS)).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
    expect(printResult).not.toHaveBeenCalled()
    expect(getTerminalHandle).not.toHaveBeenCalled()
  })

  it.each([
    ['generation', '1'],
    ['provider', 'claude']
  ])('rejects a response contradicting known %s without another call', async (flag, value) => {
    resolveRequestShow(baseResult())
    await expect(runRequestShow([...BASE_FLAGS, [flag, value]])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(callMock).toHaveBeenCalledOnce()
    expect(printResult).not.toHaveBeenCalled()
  })

  it.each(['method_not_found', 'invalid_argument', 'forbidden'])(
    'preserves old-host/auth refusal %s without retry',
    async (code) => {
      callMock.mockRejectedValue(new RuntimeClientError(code, 'host refused'))
      await expect(runRequestShow(BASE_FLAGS)).rejects.toMatchObject({
        code: code === 'forbidden' ? code : 'incompatible_runtime'
      })
      expect(callMock).toHaveBeenCalledOnce()
      expect(printResult).not.toHaveBeenCalled()
      expect(getTerminalHandle).not.toHaveBeenCalled()
    }
  )

  it('keeps requested current evidence separate and rejects missing current evidence', async () => {
    resolveRequestShow(
      baseResult('matched', {
        ...historicalMatch,
        currentBinding: { state: 'mismatch', reason: 'current process differs' }
      })
    )
    await runRequestShow([...BASE_FLAGS, ['current-terminal', 'term_current']])
    expect(callMock).toHaveBeenCalledOnce()
    expect(vi.mocked(printResult).mock.calls[0][0].result).toMatchObject({
      match: { receipt: historicalMatch.receipt, currentBinding: { state: 'mismatch' } }
    })
    callMock.mockClear()
    resolveRequestShow(baseResult())
    await expect(
      runRequestShow([...BASE_FLAGS, ['current-terminal', 'term_current']])
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledOnce()
  })
})
