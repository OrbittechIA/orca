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
