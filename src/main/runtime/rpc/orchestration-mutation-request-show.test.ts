import './unused-default-rpc-methods.test-fixture'
// A lost mutation response must be answerable without mutating again: these cover
// `orchestration.requestShow` reading the same durable receipt --retry-request replays.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'
import { hashCanonical } from './orchestration-mutation-receipt'
import { RequestShowParams } from '../../../shared/rpc-contract/orchestration-runs-mutation-request-show-params'

// Why: filter the shipped array rather than importing the module, so the test also
// fails if the method exists but was never registered with the orchestration surface.
const REQUEST_SHOW_METHODS = ORCHESTRATION_METHODS.filter(
  (method) => method.name === 'orchestration.requestShow'
)

const Params = z.object({ subject: z.string() })

function createHarness() {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const effect = vi.fn((subject: string) =>
    db.insertMessage({ runId: 'run_legacy_local', from: 'caller', to: 'recipient', subject })
  )
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      defineMethod({
        name: 'orchestration.send',
        permission: 'workspace',
        params: Params,
        handler: ({ subject }) => ({ message: effect(subject) })
      }),
      ...REQUEST_SHOW_METHODS
    ]
  })
  return { db, runtime, dispatcher, effect }
}

function sendRequest(mutationId: string): RpcRequest {
  return {
    id: `rpc_${mutationId}`,
    authToken: 'caller-token',
    method: 'orchestration.send',
    params: { subject: 'hello' },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: mutationId
  }
}

function showRequest(requestId: string): RpcRequest {
  return {
    id: `rpc_show_${requestId}`,
    authToken: 'caller-token',
    method: 'orchestration.requestShow',
    params: { request: requestId },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
  }
}

describe('orchestration.requestShow', () => {
  it('reports a recorded mutation as completed without repeating its effect', async () => {
    const { dispatcher, effect } = createHarness()
    await dispatcher.dispatch(sendRequest('mutation_completed'))

    const response = await dispatcher.dispatch(showRequest('mutation_completed'))

    expect(response).toMatchObject({
      ok: true,
      result: { requestId: 'mutation_completed', state: 'completed', method: 'orchestration.send' }
    })
    expect(effect).toHaveBeenCalledOnce()
  })

  it('returns the stored receipt so the caller can read the original outcome', async () => {
    const { dispatcher } = createHarness()
    const first = await dispatcher.dispatch(sendRequest('mutation_receipt'))

    const response = await dispatcher.dispatch(showRequest('mutation_receipt'))

    const result = (response as { result: { receipt: { message: { id: string } } } }).result
    const sent = (first as { result: { message: { id: string } } }).result
    expect(result.receipt.message.id).toBe(sent.message.id)
  })

  it('reports an interrupted mutation as pending and names the keyed replay', async () => {
    const { db, dispatcher } = createHarness()
    db.beginMutationReceipt({
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'mutation_pending',
      method: 'orchestration.workerStart',
      payloadHash: 'hash'
    })

    const response = await dispatcher.dispatch(showRequest('mutation_pending'))

    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('pending')
    expect(result.interpretation).toContain('--retry-request mutation_pending')
  })

  it('does not claim a concurrently running mutation was interrupted by a restart', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    let finishMutation: (() => void) | undefined
    let reportStarted: (() => void) | undefined
    const mutationFinished = new Promise<void>((resolve) => {
      finishMutation = resolve
    })
    const mutationStarted = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.send',
          permission: 'workspace',
          params: Params,
          handler: async () => {
            reportStarted?.()
            await mutationFinished
            return { sent: true }
          }
        }),
        ...REQUEST_SHOW_METHODS
      ]
    })

    const runningMutation = dispatcher.dispatch(sendRequest('mutation_running'))
    await mutationStarted

    const response = await dispatcher.dispatch(showRequest('mutation_running'))
    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('pending')
    expect(result.interpretation).toContain('may still be running')
    expect(result.interpretation).not.toContain('so Orca restarted')

    finishMutation?.()
    await runningMutation
  })

  it('reports an unknown request as absent without claiming nothing happened', async () => {
    const { dispatcher } = createHarness()

    const response = await dispatcher.dispatch(showRequest('mutation_missing'))

    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('absent')
    expect(result.interpretation).toContain('not proof that nothing happened')
  })

  it('scopes receipts to the caller identity that recorded them', async () => {
    const { dispatcher } = createHarness()
    await dispatcher.dispatch(sendRequest('mutation_scoped'))

    const response = await dispatcher.dispatch(showRequest('mutation_scoped'), {
      authenticatedCallerFingerprint: 'some-other-paired-device'
    })

    expect((response as { result: { state: string } }).result.state).toBe('absent')
  })

  it('never records a receipt of its own', async () => {
    const { db, dispatcher } = createHarness()
    const response = await dispatcher.dispatch(showRequest('mutation_readonly'))

    expect(response).toMatchObject({ ok: true })
    expect(
      db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), 'mutation_readonly')
    ).toBeUndefined()
  })
})

const promptBinding = { ptyId: 'pty_1', processIncarnation: 'inc_1', generation: 0 }
const promptPayloadHash = `${hashCanonical({ method: 'terminal.send', params: { text: 'mission A' } })}:${hashCanonical(promptBinding)}`
const promptReceipt = {
  send: {
    handle: 'term_original',
    prompt: {
      requestId: 'prompt_1',
      provider: 'codex',
      ...promptBinding,
      stages: ['input_accepted', 'turn_started']
    }
  }
}

function seedPrompt(
  db: OrchestrationDb,
  requestId: string,
  payloadHash = promptPayloadHash,
  callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
) {
  const identity = { callerFingerprint, requestId, method: 'terminal.send', payloadHash }
  db.beginMutationReceipt(identity)
  db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(promptReceipt) })
  return identity
}

function lookupRequest(params: Record<string, unknown> = {}): RpcRequest {
  return {
    ...showRequest('lookup'),
    params: { method: 'terminal.send', payloadHash: promptPayloadHash, ...params }
  }
}

describe('caller-scoped canonical prompt lookup', () => {
  it('matches the complete hash and native prompt fields without writing', async () => {
    const { db, dispatcher } = createHarness()
    seedPrompt(db, 'prompt_1')
    const before = db.db.prepare('SELECT total_changes() AS n').get()
    const response = await dispatcher.dispatch(
      lookupRequest({
        prompt: {
          terminal: 'term_original',
          processIncarnation: 'inc_1',
          generation: 0,
          provider: 'codex'
        }
      })
    )
    expect(response).toMatchObject({
      ok: true,
      result: {
        lookup: { version: 1, outcome: 'matched' },
        match: { requestId: 'prompt_1', payloadHash: promptPayloadHash, receipt: promptReceipt }
      }
    })
    expect(db.db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })

  it('does not create a local caller identity on an empty read', async () => {
    const { db, dispatcher } = createHarness()
    const before = db.db.prepare('SELECT total_changes() AS n').get()
    expect(await dispatcher.dispatch(lookupRequest())).toMatchObject({
      ok: true,
      result: {
        lookup: { outcome: 'zero' },
        interpretation: expect.stringContaining('not proof')
      }
    })
    expect(db.getLocalMutationCallerFingerprint()).toBeUndefined()
    expect(db.db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
  })

  it('does not expose another caller or select one of multiple matches', async () => {
    const { db, dispatcher } = createHarness()
    seedPrompt(db, 'foreign', promptPayloadHash, 'other-caller')
    const local = db.getOrCreateLocalMutationCallerFingerprint()
    expect(await dispatcher.dispatch(lookupRequest())).toMatchObject({
      result: { lookup: { outcome: 'zero' } }
    })
    seedPrompt(db, 'one', promptPayloadHash, local)
    seedPrompt(db, 'two', promptPayloadHash, local)
    const multiple = await dispatcher.dispatch(lookupRequest())
    expect(multiple).toMatchObject({ result: { lookup: { outcome: 'multiple' } } })
    if (!multiple.ok) {
      throw new Error(multiple.error.message)
    }
    expect(multiple.result).not.toHaveProperty('match')
  })

  it('does not reuse a receipt from another method with the same hash', async () => {
    const { db, dispatcher } = createHarness()
    db.beginMutationReceipt({
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'other_method',
      method: 'orchestration.send',
      payloadHash: promptPayloadHash
    })
    expect(await dispatcher.dispatch(lookupRequest())).toMatchObject({
      result: { lookup: { outcome: 'zero' } }
    })
  })

  it.each([
    {
      payloadHash: `${hashCanonical({ method: 'terminal.send', params: { text: 'mission B' } })}:${hashCanonical(promptBinding)}`
    },
    {
      payloadHash: `${promptPayloadHash.split(':')[0]}:${hashCanonical({ ...promptBinding, generation: 1 })}`
    },
    { prompt: { terminal: 'term_later' } },
    { prompt: { processIncarnation: 'inc_other' } },
    { prompt: { generation: 1 } },
    { prompt: { provider: 'claude' } }
  ])('does not correlate a different mission, payload, or prompt binding: %j', async (params) => {
    const { db, dispatcher } = createHarness()
    seedPrompt(db, 'prompt_1')
    expect(await dispatcher.dispatch(lookupRequest(params))).toMatchObject({
      result: { lookup: { outcome: 'zero' } }
    })
  })

  it('observes a late receipt without replaying or settling it', async () => {
    const { db, dispatcher, effect } = createHarness()
    const identity = {
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'late',
      method: 'terminal.send',
      payloadHash: promptPayloadHash
    }
    db.beginMutationReceipt(identity)
    expect(await dispatcher.dispatch(lookupRequest())).toMatchObject({
      result: { match: { state: 'pending' } }
    })
    expect(
      await dispatcher.dispatch(lookupRequest({ prompt: { provider: 'codex' } }))
    ).toMatchObject({ result: { lookup: { outcome: 'zero' } } })
    db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(promptReceipt) })
    expect(
      await dispatcher.dispatch(lookupRequest({ prompt: { provider: 'codex' } }))
    ).toMatchObject({ result: { match: { requestId: 'late', state: 'completed' } } })
    expect(effect).not.toHaveBeenCalled()
  })

  it('rejects a Core fingerprint, incomplete hash, or mixed request selectors', () => {
    for (const params of [
      {},
      { method: 'terminal.send', payloadHash: 'f'.repeat(64) },
      { method: 'terminal.send', payloadHash: 'a:b' },
      { request: 'known', method: 'terminal.send', payloadHash: promptPayloadHash },
      { request: 'known', providerSessionId: 'session' }
    ]) {
      expect(RequestShowParams.safeParse(params).success).toBe(false)
    }
  })

  it('returns current evidence separately from the unchanged historical receipt', async () => {
    const { db, dispatcher, runtime } = createHarness()
    seedPrompt(db, 'prompt_1')
    const snapshot = {
      terminal: 'term_current',
      ...promptBinding,
      paneKey: 'tab:pane',
      connectionId: null,
      launchTokenHash: 'launch-hash',
      provider: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session_1' },
      observedAt: Date.now()
    }
    vi.spyOn(runtime, 'getTerminalPromptCurrentBinding').mockReturnValue(snapshot)
    const show = {
      ...showRequest('prompt_1'),
      params: {
        request: 'prompt_1',
        currentTerminal: 'term_current',
        providerSessionId: 'session_1'
      }
    }
    expect(await dispatcher.dispatch(show)).toMatchObject({
      result: {
        receipt: promptReceipt,
        currentBinding: { state: 'observed', snapshot }
      }
    })
    for (const changed of [
      { ...snapshot, provider: 'claude' as const },
      { ...snapshot, processIncarnation: 'inc_2' },
      { ...snapshot, generation: 1 },
      { ...snapshot, providerSession: { key: 'session_id' as const, id: 'other' } }
    ]) {
      vi.mocked(runtime.getTerminalPromptCurrentBinding).mockReturnValue(changed)
      expect(await dispatcher.dispatch(show)).toMatchObject({
        result: {
          receipt: promptReceipt,
          currentBinding: { state: 'mismatch' }
        }
      })
    }
    vi.mocked(runtime.getTerminalPromptCurrentBinding).mockReturnValue(null)
    expect(await dispatcher.dispatch(show)).toMatchObject({
      result: { currentBinding: { state: 'unverifiable' } }
    })
    expect(
      db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), 'prompt_1')?.receipt
    ).toBe(JSON.stringify(promptReceipt))
  })
})

const HISTORICAL_BASE = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const HISTORICAL_HASH = `${HISTORICAL_BASE}:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210`
const HISTORICAL_OTHER_HASH = `${HISTORICAL_BASE}:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
const HISTORICAL_LOCATOR = { terminal: 'term_original', processIncarnation: 'inc_1' }

function seedHistoricalReceipt(
  db: OrchestrationDb,
  options: {
    requestId?: string
    callerFingerprint?: string
    method?: string
    payloadHash?: string
    receipt?: string | null
  } = {}
) {
  const identity = {
    callerFingerprint: options.callerFingerprint ?? 'historical-caller',
    requestId: options.requestId ?? 'historical_1',
    method: options.method ?? 'terminal.send',
    payloadHash: options.payloadHash ?? HISTORICAL_HASH
  }
  db.beginMutationReceipt(identity)
  if (options.receipt !== null) {
    db.completeMutationReceipt({
      ...identity,
      receipt: options.receipt ?? JSON.stringify(promptReceipt)
    })
  }
  return identity
}

function receiptReadSnapshot(db: OrchestrationDb) {
  return db.db
    .prepare(`SELECT total_changes() AS changes,
    (SELECT COUNT(*) FROM mutation_receipts) AS receipts,
    (SELECT COUNT(*) FROM mutation_caller_identities) AS caller_identities`)
    .get()
}

async function historicalRead(
  harness: ReturnType<typeof createHarness>,
  params: Record<string, unknown> = {},
  caller: string | null = 'historical-caller'
) {
  const { db, runtime, dispatcher, effect } = harness
  const before = receiptReadSnapshot(db)
  const identity = vi.spyOn(db, 'getOrCreateLocalMutationCallerFingerprint')
  const begin = vi.spyOn(db, 'beginMutationReceipt')
  const send = vi
    .spyOn(runtime, 'sendTerminal')
    .mockRejectedValue(new Error('Unexpected terminal send'))
  const prompt = vi
    .spyOn(runtime, 'sendTerminalAgentPrompt')
    .mockRejectedValue(new Error('Unexpected prompt send'))
  const launch = vi
    .spyOn(runtime, 'createTerminal')
    .mockRejectedValue(new Error('Unexpected terminal launch'))
  try {
    const response = await dispatcher.dispatch(
      {
        ...showRequest('historical_read'),
        params: {
          method: 'terminal.send',
          payloadBaseHash: HISTORICAL_BASE,
          prompt: HISTORICAL_LOCATOR,
          ...params
        }
      },
      caller === null ? undefined : { authenticatedCallerFingerprint: caller }
    )
    expect(receiptReadSnapshot(db)).toEqual(before)
    ;[identity, begin, send, prompt, launch, effect].forEach((spy) =>
      expect(spy).not.toHaveBeenCalled()
    )
    return response
  } finally {
    ;[identity, begin, send, prompt, launch].forEach((spy) => spy.mockRestore())
  }
}

function expectAmbiguous(
  response: Awaited<ReturnType<typeof historicalRead>>,
  outcome: 'zero' | 'multiple' = 'zero'
) {
  expect(response).toMatchObject({
    ok: true,
    result: {
      lookup: { version: 1, outcome, payloadBaseHash: HISTORICAL_BASE },
      interpretation: expect.stringContaining('not proof that nothing happened')
    }
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  expect(response.result).not.toHaveProperty('match')
}

describe('historical base-hash lookup on real SQLite', () => {
  it('projects one stored canonical full hash and original history without creating a local identity', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    expect(await historicalRead(harness)).toMatchObject({
      ok: true,
      result: {
        lookup: { version: 1, outcome: 'matched', payloadBaseHash: HISTORICAL_BASE },
        match: {
          requestId: 'historical_1',
          state: 'completed',
          method: 'terminal.send',
          payloadHash: HISTORICAL_HASH,
          receipt: promptReceipt
        },
        interpretation: expect.stringContaining(
          'not current ownership, settlement or recovery authorization'
        )
      }
    })
    expect(harness.db.getLocalMutationCallerFingerprint()).toBeUndefined()
  })

  it.each(['paired', 'local'])(
    'keeps an empty %s read ambiguous and identity-free',
    async (transport) => {
      const harness = createHarness()
      expectAmbiguous(
        await historicalRead(harness, {}, transport === 'local' ? null : 'historical-caller')
      )
      expect(harness.db.getLocalMutationCallerFingerprint()).toBeUndefined()
    }
  )

  it('reads the existing local identity without creating another one', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db, {
      callerFingerprint: harness.db.getOrCreateLocalMutationCallerFingerprint()
    })
    expect(await historicalRead(harness, {}, null)).toMatchObject({
      result: { lookup: { outcome: 'matched' } }
    })
  })

  it('does not expose a receipt to a different authenticated caller', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    expectAmbiguous(await historicalRead(harness, {}, 'different-caller'))
  })

  it('does not reuse another method with the same base and locators', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db, { method: 'orchestration.send' })
    expectAmbiguous(await historicalRead(harness))
  })

  it.each([
    { prompt: { ...HISTORICAL_LOCATOR, terminal: 'term_later' } },
    { prompt: { ...HISTORICAL_LOCATOR, processIncarnation: 'inc_later' } },
    { prompt: { ...HISTORICAL_LOCATOR, terminal: 'term_%' } },
    { prompt: { ...HISTORICAL_LOCATOR, processIncarnation: "inc_1' OR 1=1 --" } },
    { prompt: { ...HISTORICAL_LOCATOR, generation: 1 } },
    { prompt: { ...HISTORICAL_LOCATOR, provider: 'claude' } }
  ])('isolates exact historical locators and optional known filters: %j', async (params) => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    expectAmbiguous(await historicalRead(harness, params))
  })

  it('does not match another exact base', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db, { payloadHash: `f${HISTORICAL_HASH.slice(1)}` })
    expectAmbiguous(await historicalRead(harness))
  })

  it.each([HISTORICAL_HASH, HISTORICAL_OTHER_HASH])(
    'never selects one of duplicate requests or different bindings: %s',
    async (secondHash) => {
      const harness = createHarness()
      seedHistoricalReceipt(harness.db)
      seedHistoricalReceipt(harness.db, { requestId: 'historical_2', payloadHash: secondHash })
      seedHistoricalReceipt(harness.db, { requestId: 'historical_3', payloadHash: secondHash })
      expectAmbiguous(await historicalRead(harness), 'multiple')
    }
  )

  it('keeps different historical generations ambiguous until actual generation0 is supplied', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    seedHistoricalReceipt(harness.db, {
      requestId: 'later_generation',
      payloadHash: HISTORICAL_OTHER_HASH,
      receipt: JSON.stringify({
        send: { handle: 'term_original', prompt: { ...promptReceipt.send.prompt, generation: 1 } }
      })
    })
    expectAmbiguous(await historicalRead(harness), 'multiple')
    expect(
      await historicalRead(harness, { prompt: { ...HISTORICAL_LOCATOR, generation: 0 } })
    ).toMatchObject({
      result: { match: { requestId: 'historical_1', payloadHash: HISTORICAL_HASH } }
    })
  })

  it('uses a known provider filter without inventing generation or current ownership', async () => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    seedHistoricalReceipt(harness.db, {
      requestId: 'other_provider',
      payloadHash: HISTORICAL_OTHER_HASH,
      receipt: JSON.stringify({
        send: {
          handle: 'term_original',
          prompt: { ...promptReceipt.send.prompt, provider: 'claude' }
        }
      })
    })
    expectAmbiguous(await historicalRead(harness), 'multiple')
    expect(
      await historicalRead(harness, { prompt: { ...HISTORICAL_LOCATOR, provider: 'codex' } })
    ).toMatchObject({ result: { match: { requestId: 'historical_1' } } })
  })

  it.each([
    HISTORICAL_BASE,
    `${HISTORICAL_BASE}:legacy`,
    `${HISTORICAL_HASH}:extra`,
    `${HISTORICAL_BASE}:${'A'.repeat(64)}`,
    HISTORICAL_HASH.slice(0, -1),
    `${HISTORICAL_HASH}0`,
    `${HISTORICAL_HASH}\n`,
    HISTORICAL_HASH.toUpperCase()
  ])('never projects a legacy or malformed stored full hash: %j', async (payloadHash) => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db, { payloadHash })
    expectAmbiguous(await historicalRead(harness))
  })

  it.each([
    `${HISTORICAL_BASE}:legacy`,
    `${HISTORICAL_HASH}:extra`,
    `${HISTORICAL_BASE}:${'A'.repeat(64)}`,
    HISTORICAL_HASH.slice(0, -1),
    `${HISTORICAL_HASH}\n`
  ])(
    'does not filter a malformed correlated shadow to manufacture uniqueness: %j',
    async (payloadHash) => {
      for (const malformedFirst of [true, false]) {
        const harness = createHarness()
        seedHistoricalReceipt(harness.db, {
          requestId: 'first',
          payloadHash: malformedFirst ? payloadHash : HISTORICAL_HASH
        })
        seedHistoricalReceipt(harness.db, {
          requestId: 'second',
          payloadHash: malformedFirst ? HISTORICAL_HASH : payloadHash
        })
        expectAmbiguous(await historicalRead(harness), 'multiple')
      }
    }
  )

  it.each([
    '{malformed json',
    JSON.stringify({ send: { prompt: promptReceipt.send.prompt } }),
    JSON.stringify({ send: { handle: 'term_original', prompt: { generation: 0 } } }),
    JSON.stringify({ send: { handle: 'term_original', prompt: { processIncarnation: 1 } } }),
    'null'
  ])('refuses invalid JSON or missing/string-invalid historical locators: %s', async (receipt) => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db, { receipt })
    expectAmbiguous(await historicalRead(harness))
  })

  it.each([
    null,
    '{malformed json',
    JSON.stringify({ send: { prompt: promptReceipt.send.prompt } }),
    JSON.stringify({ send: { handle: 'term_original', prompt: { generation: 0 } } }),
    JSON.stringify({ send: { handle: '', prompt: promptReceipt.send.prompt } }),
    JSON.stringify({
      send: {
        handle: 'term_original',
        prompt: { ...promptReceipt.send.prompt, processIncarnation: 1 }
      }
    }),
    JSON.stringify({
      send: { handle: { pane: 'term_original' }, prompt: promptReceipt.send.prompt }
    }),
    JSON.stringify({
      send: { handle: 'term_original', prompt: { ...promptReceipt.send.prompt, generation: '0' } }
    }),
    JSON.stringify({
      send: {
        handle: 'term_original',
        prompt: { ...promptReceipt.send.prompt, provider: 'unknown' }
      }
    })
  ])(
    'keeps uncertain history paired with a valid shadow ambiguous in both insertion orders: %j',
    async (receipt) => {
      for (const uncertainFirst of [true, false]) {
        const harness = createHarness()
        seedHistoricalReceipt(harness.db, {
          requestId: 'first',
          receipt: uncertainFirst ? receipt : JSON.stringify(promptReceipt)
        })
        seedHistoricalReceipt(harness.db, {
          requestId: 'second',
          payloadHash: HISTORICAL_OTHER_HASH,
          receipt: uncertainFirst ? JSON.stringify(promptReceipt) : receipt
        })
        expectAmbiguous(
          await historicalRead(harness, {
            prompt: { ...HISTORICAL_LOCATOR, generation: 0, provider: 'codex' }
          }),
          'multiple'
        )
      }
    }
  )

  it.each([
    { send: { prompt: { ...promptReceipt.send.prompt, processIncarnation: 'known_other' } } },
    { send: { handle: 'known_other', prompt: { generation: 0 } } },
    { send: { handle: 'term_original', prompt: { generation: 1 } } },
    { send: { handle: 'term_original', prompt: { provider: 'claude' } } }
  ])(
    'preserves uniqueness when recorded fields prove uncertain rows belong to different history: %j',
    async (receipt) => {
      const harness = createHarness()
      seedHistoricalReceipt(harness.db)
      seedHistoricalReceipt(harness.db, {
        requestId: 'different_history',
        payloadHash: HISTORICAL_OTHER_HASH,
        receipt: JSON.stringify(receipt)
      })
      expect(
        await historicalRead(harness, {
          prompt: { ...HISTORICAL_LOCATOR, generation: 0, provider: 'codex' }
        })
      ).toMatchObject({ result: { match: { requestId: 'historical_1' } } })
    }
  )

  it.each([{ pane: 'term_original' }, ['term_original']])(
    'refuses SQLite object/array TEXT coercion, preserving correlated ambiguity: %j',
    async (handle) => {
      const harness = createHarness()
      const terminal = JSON.stringify(handle)
      seedHistoricalReceipt(harness.db, {
        receipt: JSON.stringify({ send: { handle, prompt: promptReceipt.send.prompt } })
      })
      expectAmbiguous(
        await historicalRead(harness, { prompt: { ...HISTORICAL_LOCATOR, terminal } })
      )
      seedHistoricalReceipt(harness.db, {
        requestId: 'valid_shadow',
        payloadHash: HISTORICAL_OTHER_HASH,
        receipt: JSON.stringify({ send: { handle: terminal, prompt: promptReceipt.send.prompt } })
      })
      expectAmbiguous(
        await historicalRead(harness, { prompt: { ...HISTORICAL_LOCATOR, terminal } }),
        'multiple'
      )
    }
  )

  it.each([
    `{"send":{"handle":"term_original","handle":"term_other","prompt":{"processIncarnation":"inc_1"}}}`,
    `{"send":{"handle":"term_other","handle":"term_original","prompt":{"processIncarnation":"inc_1"}}}`,
    `{"send":{"handle":"term_other"},"send":{"handle":"term_original","prompt":{"processIncarnation":"inc_1"}}}`,
    `{"send":{"handle":"term_original","prompt":{"processIncarnation":"other"},"prompt":{"processIncarnation":"inc_1"}}}`,
    `{"send":{"handle":"term_original","prompt":{"processIncarnation":"other","processIncarnation":"inc_1"}}}`
  ])('rejects duplicate keys alone and in paired history: %s', async (receipt) => {
    const lone = createHarness()
    seedHistoricalReceipt(lone.db, { receipt })
    expectAmbiguous(await historicalRead(lone))
    for (const duplicateFirst of [true, false]) {
      const harness = createHarness()
      seedHistoricalReceipt(harness.db, {
        requestId: 'first',
        receipt: duplicateFirst ? receipt : JSON.stringify(promptReceipt)
      })
      seedHistoricalReceipt(harness.db, {
        requestId: 'second',
        receipt: duplicateFirst ? JSON.stringify(promptReceipt) : receipt
      })
      expectAmbiguous(await historicalRead(harness), 'multiple')
    }
  })

  it('keeps a pending receipt without locators ambiguous and observes a later receipt without replay', async () => {
    const harness = createHarness()
    const identity = seedHistoricalReceipt(harness.db, { receipt: null })
    expectAmbiguous(await historicalRead(harness))
    harness.db.checkpointPendingMutationReceipt({
      ...identity,
      receipt: JSON.stringify(promptReceipt)
    })
    expect(await historicalRead(harness)).toMatchObject({
      result: {
        match: {
          state: 'pending',
          receipt: promptReceipt,
          interpretation: expect.stringContaining('may still be running')
        }
      }
    })
    harness.db.completeMutationReceipt({ ...identity, receipt: JSON.stringify(promptReceipt) })
    expect(await historicalRead(harness)).toMatchObject({
      result: { match: { state: 'completed', receipt: promptReceipt } }
    })
  })

  it.each([
    { payloadBaseHash: HISTORICAL_BASE.slice(1) },
    { payloadBaseHash: `${HISTORICAL_BASE}0` },
    { payloadBaseHash: HISTORICAL_BASE.toUpperCase() },
    { payloadBaseHash: `${HISTORICAL_BASE.slice(1)}%` },
    { payloadBaseHash: `${HISTORICAL_BASE}\n` },
    { request: 'request_1' },
    { payloadHash: HISTORICAL_HASH },
    { method: 'terminal.create' },
    { method: undefined },
    { prompt: undefined },
    { prompt: { terminal: 'term_original' } },
    { prompt: { processIncarnation: 'inc_1' } },
    { prompt: { ...HISTORICAL_LOCATOR, terminal: '' } },
    { prompt: { ...HISTORICAL_LOCATOR, processIncarnation: '' } },
    { prompt: { ...HISTORICAL_LOCATOR, generation: -1 } },
    { prompt: { ...HISTORICAL_LOCATOR, provider: 'unknown' } },
    { providerSessionId: 'session_1' }
  ])('rejects invalid schema combinations without DB or runtime effects: %j', async (params) => {
    const harness = createHarness()
    seedHistoricalReceipt(harness.db)
    expect(await historicalRead(harness, params)).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
  })

  it.each(['observed', 'mismatch', 'absent'])(
    'keeps %s current binding separate from historical receipt selection',
    async (state) => {
      const harness = createHarness()
      const payloadHash = `${HISTORICAL_BASE}:${hashCanonical(promptBinding)}`
      seedHistoricalReceipt(harness.db, { payloadHash })
      const snapshot = {
        terminal: 'term_current',
        ...promptBinding,
        paneKey: 'tab:pane',
        connectionId: null,
        launchTokenHash: 'launch-hash',
        provider: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'session_1' },
        observedAt: Date.now()
      }
      vi.spyOn(harness.runtime, 'getTerminalPromptCurrentBinding').mockReturnValue(
        state === 'absent' ? null : state === 'mismatch' ? { ...snapshot, generation: 1 } : snapshot
      )
      expect(
        await historicalRead(harness, {
          currentTerminal: 'term_current',
          providerSessionId: 'session_1'
        })
      ).toMatchObject({
        result: {
          match: {
            payloadHash,
            receipt: promptReceipt,
            currentBinding: { state: state === 'absent' ? 'unverifiable' : state }
          }
        }
      })
      expect(harness.db.getMutationReceipt('historical-caller', 'historical_1')?.receipt).toBe(
        JSON.stringify(promptReceipt)
      )
    }
  )
})
