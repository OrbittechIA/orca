import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { isUnknownRecord } from '../../../src/shared/unknown-record'

const storage = vi.hoisted(() => {
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
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }))

import {
  startWorkItemStructuredSession,
  retryWorkItemStartStructuredSession
} from './work-item-start-structured-session'
import { readWorkItemStartAttempt } from './work-item-start-attempt-journal'
import { readWorkItemStartSendIdentity } from './work-item-start-send-identity-journal'
import { structuredAgentSessionDomainFingerprint } from '../../../src/shared/structured-agent-session-mutation'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'

const LEGACY_SEND_KEY = 'orca:mobileStructuredSendOperations:v1'
const ATTEMPT_KEY = 'orca:mobileWorkItemStartAttempts:v1'
const IDENTITY_KEY = 'orca:mobileWorkItemStartSendIdentities:v1'
const WORKTREE = 'retry-reconciliation-workspace'

function record(value: unknown): Record<string, unknown> {
  return isUnknownRecord(value) ? value : {}
}

function createdSession(sessionId: string): RpcResponse {
  const cursor = { epoch: 'test-epoch', sequence: 0 }
  return {
    id: 'create-response',
    ok: true,
    result: {
      ok: true,
      replayed: true,
      fence: 3,
      cursor,
      value: {
        sessionId,
        fence: 3,
        unconfirmedClientMessageIds: [],
        page: {
          sessionId,
          epoch: cursor.epoch,
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [],
          window: { oldest: null, newest: null, nextCursor: cursor },
          liveCursor: cursor,
          hasOlder: false,
          hasNewer: false
        }
      }
    }
  }
}

function host() {
  const accepted = new Map<string, RpcResponse>()
  const client = new FakeSession('connected')
  const sends: string[] = []
  let loseReplies = true
  client.sendRequest.mockImplementation(async (method, raw) => {
    const params = record(raw)
    const envelope = record(params.envelope)
    if (method === 'agentSession.createSupport') {
      return { id: 'support-response', ok: true, result: { supported: true } }
    }
    if (method === 'agentSession.create') {
      return createdSession(String(envelope.sessionId))
    }
    if (method !== 'agentSession.send') {
      throw new Error(`Unexpected method ${method}`)
    }
    const operationId = String(envelope.clientOperationId)
    sends.push(operationId)
    const receipt: RpcResponse = accepted.get(operationId) ?? {
      id: 'send-response',
      ok: true,
      result: {
        ok: true,
        value: {
          clientMessageId: operationId,
          submission: { clientMessageId: operationId, dispatchState: 'accepted' }
        }
      }
    }
    accepted.set(operationId, receipt)
    if (loseReplies) {
      throw markRpcDeliveryUnknown(new Error('Reply lost after acceptance'))
    }
    return receipt
  })
  return {
    client,
    accepted,
    sends,
    recover: () => {
      loseReplies = false
    }
  }
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(5_000)
  return promise
}

function start(client: RpcClient) {
  return settle(
    startWorkItemStructuredSession({
      client,
      worktreeId: WORKTREE,
      agent: 'codex',
      prompt: 'Synthetic work item'
    })
  )
}

function retry(client: RpcClient) {
  return settle(retryWorkItemStartStructuredSession({ client, worktreeId: WORKTREE }))
}

beforeEach(() => {
  storage.store.clear()
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    storage.store.set(key, value)
  })
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

it('replays the same send from Start metadata after the retired chat journal is gone', async () => {
  const server = host()
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  const attempt = await readWorkItemStartAttempt(WORKTREE)
  if (!attempt) {
    throw new Error('Missing retained attempt')
  }
  const heldSendId = await readWorkItemStartSendIdentity(attempt)
  expect(heldSendId).toBe(server.sends[0])
  expect(storage.store.has(LEGACY_SEND_KEY)).toBe(false)
  server.recover()
  expect(await retry(server.client)).toMatchObject({ kind: 'started' })
  expect(server.accepted.size).toBe(1)
  expect(new Set(server.sends)).toEqual(new Set([heldSendId]))
  expect(await retry(server.client)).toBeNull()
})

it('retains the send id when clearing the completed attempt fails', async () => {
  const server = host()
  server.recover()
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    if (key === ATTEMPT_KEY && JSON.parse(value).attempts.length === 0) {
      throw new Error('Cleanup unavailable')
    }
    storage.store.set(key, value)
  })
  expect(await start(server.client)).toMatchObject({ kind: 'started' })
  expect(storage.store.has(LEGACY_SEND_KEY)).toBe(false)
  expect(await readWorkItemStartAttempt(WORKTREE)).not.toBeNull()
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    storage.store.set(key, value)
  })
  expect(await retry(server.client)).toMatchObject({ kind: 'started' })
  expect(server.accepted.size).toBe(1)
  expect(new Set(server.sends).size).toBe(1)
})

function seedLegacySendIdentity() {
  const sidecar = JSON.parse(storage.store.get(IDENTITY_KEY) ?? '{}')
  const held = sidecar.identities[0]
  const attachmentPaths: string[] = []
  const entry = {
    operationKey: structuredAgentSessionDomainFingerprint({
      domain: 'mobile.agentSession.send.operation',
      sessionId: held.binding.sessionId,
      fields: { intentFingerprint: held.binding.payloadFingerprint }
    }),
    operationId: held.sendClientOperationId,
    callerFingerprint: held.binding.callerFingerprint,
    payloadFingerprint: held.binding.payloadFingerprint,
    attachmentPaths
  }
  storage.store.set(LEGACY_SEND_KEY, JSON.stringify({ v: 1, entries: [entry] }))
  return entry
}

it('migrates a legacy pending attempt using its retained send id without rewriting old bytes', async () => {
  const server = host()
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  seedLegacySendIdentity()
  const original = storage.store.get(LEGACY_SEND_KEY)
  storage.store.delete(IDENTITY_KEY)
  server.recover()
  expect(await retry(server.client)).toMatchObject({ kind: 'started' })
  expect(server.accepted.size).toBe(1)
  expect(new Set(server.sends).size).toBe(1)
  expect(storage.store.get(LEGACY_SEND_KEY)).toBe(original)
  expect(storage.setItem.mock.calls.filter(([key]) => key === LEGACY_SEND_KEY)).toEqual([])
  expect(storage.removeItem.mock.calls.filter(([key]) => key === LEGACY_SEND_KEY)).toEqual([])
})

it('sends nothing until its attempt durably retains the send id', async () => {
  const server = host()
  server.recover()
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    if (key === IDENTITY_KEY) {
      throw new Error('Identity write unavailable')
    }
    storage.store.set(key, value)
  })
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  expect(server.client.sendRequest).not.toHaveBeenCalled()
  expect(server.sends).toEqual([])
  expect(await readWorkItemStartAttempt(WORKTREE)).not.toBeNull()
  storage.setItem.mockImplementation(async (key: string, value: string) => {
    storage.store.set(key, value)
  })
  expect(await retry(server.client)).toMatchObject({ kind: 'unconfirmed' })
  expect(server.sends).toEqual([])
  expect(server.accepted.size).toBe(0)
})

it('refuses to mint a new send for a legacy attempt whose send journal is gone', async () => {
  const server = host()
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  storage.store.delete(IDENTITY_KEY)
  const sendsBefore = [...server.sends]
  server.recover()
  expect(await retry(server.client)).toMatchObject({
    kind: 'unconfirmed',
    message: expect.stringContaining('Check the conversation')
  })
  expect(server.sends).toEqual(sendsBefore)
  expect(server.accepted.size).toBe(1)
  expect(storage.store.has(LEGACY_SEND_KEY)).toBe(false)
  expect(await readWorkItemStartAttempt(WORKTREE)).not.toBeNull()
})

it('refuses a retained legacy send that conflicts with the Start identity', async () => {
  const server = host()
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  const shared = seedLegacySendIdentity()
  const operationId = shared.operationId
  shared.operationId = operationId.slice(0, -1) + (operationId.endsWith('a') ? 'b' : 'a')
  const original = JSON.stringify({ v: 1, entries: [shared] })
  storage.store.set(LEGACY_SEND_KEY, original)
  const sendsBefore = [...server.sends]
  server.recover()
  expect(await retry(server.client)).toMatchObject({
    kind: 'unconfirmed',
    message: expect.stringContaining('identity conflicts')
  })
  expect(server.sends).toEqual(sendsBefore)
  expect(server.accepted.size).toBe(1)
  expect(storage.store.get(LEGACY_SEND_KEY)).toBe(original)
  expect(await readWorkItemStartAttempt(WORKTREE)).not.toBeNull()
})

it.each(['caller', 'payload', 'attachments', 'duplicate', 'invalid-id', 'corrupt'])(
  'refuses ambiguous legacy %s metadata without sending or rewriting it',
  async (fault) => {
    const server = host()
    expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
    const held = seedLegacySendIdentity()
    const legacy = { v: 1, entries: [held] }
    if (fault === 'caller') {
      held.callerFingerprint = 'a'.repeat(64)
    }
    if (fault === 'payload') {
      held.payloadFingerprint = 'b'.repeat(64)
    }
    if (fault === 'attachments') {
      held.attachmentPaths.push('unexpected.png')
    }
    if (fault === 'duplicate') {
      legacy.entries.push({ ...held })
    }
    if (fault === 'invalid-id') {
      held.operationId = 'unretained-send'
    }
    const original = fault === 'corrupt' ? '{broken' : JSON.stringify(legacy)
    storage.store.set(LEGACY_SEND_KEY, original)
    storage.store.delete(IDENTITY_KEY)
    const sendsBefore = [...server.sends]
    server.recover()
    expect(await retry(server.client)).toMatchObject({ kind: 'unconfirmed' })
    expect(server.sends).toEqual(sendsBefore)
    expect(storage.store.get(LEGACY_SEND_KEY)).toBe(original)
    expect(storage.setItem.mock.calls.filter(([key]) => key === LEGACY_SEND_KEY)).toEqual([])
    expect(storage.removeItem.mock.calls.filter(([key]) => key === LEGACY_SEND_KEY)).toEqual([])
  }
)

it('refuses another legacy session identity instead of matching its payload alone', async () => {
  const server = host()
  expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
  const held = seedLegacySendIdentity()
  held.operationKey = structuredAgentSessionDomainFingerprint({
    domain: 'mobile.agentSession.send.operation',
    sessionId: 'other_session',
    fields: { intentFingerprint: held.payloadFingerprint }
  })
  const original = JSON.stringify({ v: 1, entries: [held] })
  storage.store.set(LEGACY_SEND_KEY, original)
  storage.store.delete(IDENTITY_KEY)
  const sendsBefore = [...server.sends]
  server.recover()
  expect(await retry(server.client)).toMatchObject({ kind: 'unconfirmed' })
  expect(server.sends).toEqual(sendsBefore)
  expect(storage.store.get(LEGACY_SEND_KEY)).toBe(original)
})

it.each(['sessionId', 'payloadFingerprint', 'callerFingerprint'])(
  'refuses a changed Start send binding %s without dispatching or replacing it',
  async (field) => {
    const server = host()
    expect(await start(server.client)).toMatchObject({ kind: 'unconfirmed' })
    const sidecar = JSON.parse(storage.store.get(IDENTITY_KEY) ?? '{}')
    sidecar.identities[0].binding[field] = field === 'sessionId' ? 'other_session' : 'c'.repeat(64)
    const original = JSON.stringify(sidecar)
    storage.store.set(IDENTITY_KEY, original)
    const sendsBefore = [...server.sends]
    server.recover()
    expect(await retry(server.client)).toMatchObject({ kind: 'unconfirmed' })
    expect(server.sends).toEqual(sendsBefore)
    expect(server.accepted.size).toBe(1)
    expect(storage.store.get(IDENTITY_KEY)).toBe(original)
  }
)
