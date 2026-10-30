// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupCreateMessageFixture,
  created,
  deferred,
  draft,
  mocks,
  resetCreateMessageFixture,
  start
} from '../../structured-agent-session-launch-create-message.test-fixture'
import {
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from '../../structured-agent-session-launch'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { CreateIntentParams } from '../../../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/structured-agent-session-mutation'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  StructuredAgentLaunchPersistenceError
} from './structured-agent-session-launch-persistence'
import { validRecord } from './structured-agent-session-launch-record'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { discardStructuredLaunchPrompts } from '../../structured-agent-session-launch-prompt'

const KEY = 'orca:structuredAgentLaunches:v1'
const originalSetItem = localStorage.setItem
const originalGetItem = localStorage.getItem
let restore: (() => void) | undefined

function workItemStart() {
  return startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    launchOrigin: 'work-item-start',
    prompt: 'opening text',
    launchOptions: { model: 'gpt-5.5', effort: 'high' }
  })
}

function storedLaunch() {
  const parsed: unknown = JSON.parse(Storage.prototype.getItem.call(localStorage, KEY) ?? '[]')
  const record = Array.isArray(parsed) ? parsed.find(validRecord) : undefined
  if (!validRecord(record)) {
    throw new Error('Expected a persisted launch')
  }
  return record
}

function expectNoMutation() {
  expect(mocks.call.mock.calls.filter(([, method]) => method !== 'agentSession.history')).toEqual([])
}

async function settleRetry(sessionId: string) {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    throw new Error('Expected a recoverable launch')
  }
  await expect(state.promise).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
  await Promise.resolve()
}

describe('Work Item Start recovery durability', () => {
  beforeEach(() => {
    restore = resetCreateMessageFixture()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // happy-dom's Storage proxy cannot delete bound methods when spies restore them.
    Object.defineProperties(localStorage, {
      setItem: { value: originalSetItem, configurable: true, writable: true },
      getItem: { value: originalGetItem, configurable: true, writable: true }
    })
    cleanupCreateMessageFixture(restore)
  })

  it('refuses a remote-client storage wrapper without a native readback contract', async () => {
    const optimistic = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => optimistic.get(key) ?? null,
      setItem: (key: string, value: string) => optimistic.set(key, value),
      removeItem: (key: string) => optimistic.delete(key)
    })
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:server-1',
      launchOrigin: 'work-item-start',
      prompt: 'opening text'
    })

    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult
    expect(optimistic.get(KEY)).toContain(launch.sessionId)
    expect(mocks.admit).not.toHaveBeenCalled()
    expectNoMutation()
  })

  it('refuses initial quota failure before host admission or any create/send and returns the text', async () => {
    const write = localStorage.setItem.bind(localStorage)
    let refused = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === KEY && !refused) {
        refused = true
        throw new DOMException('quota full', 'QuotaExceededError')
      }
      write(key, value)
    })

    const launch = workItemStart()
    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult

    expect(refused).toBe(true)
    expect(mocks.admit).not.toHaveBeenCalled()
    expectNoMutation()
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe('failed')
  })

  it('refuses quota failure when freezing firstMessage/options, including a retry without restaged text', async () => {
    const write = localStorage.setItem.bind(localStorage)
    let preparedWrites = 0
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === KEY && value.includes('firstMessage')) {
        preparedWrites += 1
        throw new DOMException('quota full', 'QuotaExceededError')
      }
      write(key, value)
    })

    const launch = workItemStart()
    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult

    expect(preparedWrites).toBeGreaterThan(0)
    expect(storedLaunch().firstMessage).toBeUndefined()
    expectNoMutation()
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await settleRetry(launch.sessionId)
    expectNoMutation()
  })

  it('rejects a silent dropped write even when the wrapper echoes its optimistic value', async () => {
    let optimistic: string | null = null
    const read = localStorage.getItem.bind(localStorage)
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === KEY) {
        optimistic = value
      } else {
        write(key, value)
      }
    })
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) =>
      key === KEY ? optimistic : read(key)
    )

    const launch = workItemStart()
    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult

    expect(localStorage.getItem(KEY)).toContain(launch.sessionId)
    expect(Storage.prototype.getItem.call(localStorage, KEY)).toBeNull()
    expectNoMutation()
  })

  it('refuses a lost storage ACK after the prepared write lands, retaining the exact reload payload', async () => {
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      write(key, value)
      if (key === KEY && value.includes('firstMessage')) {
        throw new Error('storage ACK lost')
      }
    })

    const launch = workItemStart()
    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult
    const saved = storedLaunch()
    expect(saved.firstMessage?.body.blocks).toEqual([{ type: 'text', text: 'opening text' }])
    expect(saved.options).toMatchObject({ model: 'gpt-5.5', effort: 'high' })
    expectNoMutation()

    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await settleRetry(launch.sessionId)
    expectNoMutation()
  })

  it('replays a lost create ACK after reload with the same IDs, firstMessage, options and fingerprint', async () => {
    const response = deferred<unknown>()
    mocks.call.mockImplementation(async (_target, method, input) => {
      if (method !== 'agentSession.create') {
        throw new Error(`Unexpected ${method}`)
      }
      const params = CreateIntentParams.parse(input)
      const record = storedLaunch()
      expect(record).toMatchObject({
        sessionId: params.envelope.sessionId,
        clientOperationId: params.envelope.clientOperationId,
        payloadFingerprint: params.envelope.payloadFingerprint,
        firstMessage: params.firstMessage,
        options: params.options,
        optionsMode: params.optionsMode
      })
      expect(params.envelope.payloadFingerprint).toBe(
        structuredAgentSessionCreateFingerprint({ sessionId: params.envelope.sessionId, ...params })
      )
      return response.promise
    })
    const launch = workItemStart()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const original = mocks.call.mock.calls[0]?.[2]
    const saved = storedLaunch()

    discardStructuredLaunchPrompts(launch.sessionId)
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentSessionSendsForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation(async () => created())
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    const restored = getStructuredLaunchStateBySessionId(launch.sessionId)
    expect(restored).toBeDefined()
    await restored?.promise

    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')).toHaveLength(2)
    expect(mocks.call.mock.calls[1]?.[2]).toEqual(original)
    expect(restored?.intent.params.envelope.clientOperationId).toBe(saved.clientOperationId)
    expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.send')).toBe(false)
  })

  it('keeps an unknown create unknown and sends nothing new when recovery storage stops confirming', async () => {
    const response = deferred<unknown>()
    mocks.call.mockImplementation(async () => response.promise)
    const launch = workItemStart()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    const original = CreateIntentParams.parse(mocks.call.mock.calls[0]?.[2])
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === KEY) {
        throw new DOMException('quota full', 'QuotaExceededError')
      }
      write(key, value)
    })
    response.reject(new Error('create ACK lost'))
    await expect(launch.launchResult).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)
    await launch.promptDeliveryResult

    expect(launch.isVisibilityUnknown()).toBe(true)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe('visibility-unknown')
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await settleRetry(launch.sessionId)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe('visibility-unknown')
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.params.envelope).toEqual(original.envelope)
  })

  it('preserves ordinary launch behavior when launch journal quota is exhausted', async () => {
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === KEY) {
        throw new DOMException('quota full', 'QuotaExceededError')
      }
      write(key, value)
    })
    mocks.call.mockImplementation(async () => created())

    const launch = start()
    await expect(launch.launchResult).resolves.toMatchObject({ sessionId: launch.sessionId })
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })
})
