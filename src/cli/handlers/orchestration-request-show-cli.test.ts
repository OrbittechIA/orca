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
