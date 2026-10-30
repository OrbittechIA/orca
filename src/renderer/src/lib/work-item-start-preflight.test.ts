// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from '../../../shared/work-item-start-structured-session-capability'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

import { requireWorkItemStartPreflight } from './work-item-start-preflight'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  StructuredAgentLaunchPersistenceError,
  writeStructuredAgentLaunchRecord
} from './agent-session/launch/structured-agent-session-launch-persistence'

const KEY = 'orca:structuredAgentLaunches:v1'
const originalSetItem = localStorage.setItem
const originalGetItem = localStorage.getItem

function preflight(
  delivery = 'submit-after-ready',
  target: RuntimeClientTarget = { kind: 'local' }
) {
  return requireWorkItemStartPreflight({ delivery, target, agent: 'codex', repoId: 'repo-1' })
}

function storedJournal() {
  return Storage.prototype.getItem.call(localStorage, KEY)
}

describe('desktop Work Item Start storage preflight', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    writeStructuredAgentLaunchRecord({
      sessionId: 'held-session',
      executionHostId: 'local',
      agent: 'codex',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'held-operation',
      payloadFingerprint: 'held-fingerprint',
      expectedRuntimeFence: null
    })
    rpc.mockReset()
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'status.get') {
        return {
          capabilities: [
            WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY,
            AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
          ]
        }
      }
      if (method === 'agentSession.createSupport') {
        return { supported: true }
      }
      throw new Error(`Unexpected effect: ${method}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // happy-dom's Storage proxy cannot delete bound methods when spies restore them.
    Object.defineProperties(localStorage, {
      setItem: { value: originalSetItem, configurable: true, writable: true },
      getItem: { value: originalGetItem, configurable: true, writable: true }
    })
  })

  it('confirms native Storage before allowing structured Start and leaves the held journal untouched', async () => {
    const held = storedJournal()
    const writes = vi.spyOn(localStorage, 'setItem')

    await expect(preflight()).resolves.toBe(true)

    expect(writes).toHaveBeenCalledTimes(1)
    expect(writes.mock.calls[0]?.[0]).toMatch(/^orca:structuredAgentLaunches:v1:probe:/)
    expect(storedJournal()).toBe(held)
    expect(localStorage.length).toBe(1)
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'status.get',
      'agentSession.createSupport'
    ])
  })

  it.each<RuntimeClientTarget>([
    { kind: 'local' },
    { kind: 'environment', environmentId: 'server-1' }
  ])('refuses current quota failure before workspace effects for %j', async (target) => {
    const held = storedJournal()
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota full', 'QuotaExceededError')
    })

    await expect(preflight('submit-after-ready', target)).rejects.toBeInstanceOf(
      StructuredAgentLaunchPersistenceError
    )

    expect(storedJournal()).toBe(held)
    expect(localStorage.length).toBe(1)
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'status.get',
      'agentSession.createSupport'
    ])
  })

  it('refuses a silently dropped probe even if the wrapper echoes success, without touching held recovery', async () => {
    const held = storedJournal()
    const read = localStorage.getItem.bind(localStorage)
    const optimistic = new Map<string, string>()
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      optimistic.set(key, value)
    })
    vi.spyOn(localStorage, 'getItem').mockImplementation((key) => optimistic.get(key) ?? read(key))

    await expect(preflight()).rejects.toBeInstanceOf(StructuredAgentLaunchPersistenceError)

    expect(optimistic.size).toBe(1)
    expect(storedJournal()).toBe(held)
    expect(localStorage.length).toBe(1)
  })

  it('leaves manual Draft available without probing storage or asking the host', async () => {
    const held = storedJournal()
    const writes = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota full', 'QuotaExceededError')
    })

    await expect(preflight('draft')).resolves.toBe(false)

    expect(writes).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(storedJournal()).toBe(held)
  })
})
