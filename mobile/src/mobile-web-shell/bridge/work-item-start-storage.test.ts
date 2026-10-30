import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import pageAsyncStorage, { publishPageStorage } from './page-async-storage'
import {
  storagePersistParamsSchema,
  storagePersistResultSchema,
  storageReadParamsSchema,
  storageReadResultSchema
} from './bridge-native-verbs'
import {
  PAGE_STORAGE_MAX_ENTRIES,
  PAGE_STORAGE_MAX_VALUE_CHARS,
  isPageStorageKeyForRoute,
  pageStorageEntriesForInit,
  pageStorageKeysForRoute
} from '../page-storage-keys'
import { compareAndPersistMirrored } from '../../storage/mirrored-storage-keys'
import { workItemStartCreateStorageKey } from '../../storage/work-item-start-storage-key'
import { CreateIntentParams } from '../../../../src/shared/rpc-contract/structured-agent-session-params'
import type { RpcClient } from '../../transport/rpc-client'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-session-create-capabilities'
import { grantsForRoute } from '../page-route-policy'

const disk = vi.hoisted(() => new Map<string, string>())
const nativeWrite = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    disk.set(key, value)
  })
)
const adapter = vi.hoisted(
  (): { current: null | Pick<typeof pageAsyncStorage, 'getItem' | 'setItem'> } => ({
    current: null
  })
)
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) =>
      adapter.current ? adapter.current.getItem(key) : Promise.resolve(disk.get(key) ?? null),
    setItem: (key: string, value: string) =>
      adapter.current ? adapter.current.setItem(key, value) : nativeWrite(key, value)
  }
}))

// Native calls use the real disk double while page-side recovery sees its bridge adapter.
async function onDevice<T>(work: () => Promise<T>): Promise<T> {
  const previous = adapter.current
  adapter.current = null
  try {
    return await work()
  } finally {
    adapter.current = previous
  }
}

async function bridge(options: { oldNative?: boolean; lostAck?: boolean; narrow?: boolean } = {}) {
  const pathname = options.narrow ? '/h/host-a/tasks' : '/h/host-a'
  const hostArea = options.narrow !== true
  const rawInit = Object.fromEntries(
    pageStorageKeysForRoute('host-a', pathname).flatMap((key) => {
      const value = disk.get(key)
      return value === undefined ? [] : [[key, value]]
    })
  )
  const init = pageStorageEntriesForInit(rawInit)
  const pair = createFakeBridgePortPair({
    route: { pathname },
    ownsHostArea: hostArea,
    pageRoutes: ['/h/[hostId]', '/h/[hostId]/tasks'],
    routeGrants: grantsForRoute(
      [
        { pathname: '/h/[hostId]', grants: ['storage'] },
        { pathname: '/h/[hostId]/tasks', grants: ['storage'] }
      ],
      pathname
    ),
    storage: init.entries,
    storageOversize: init.oversize,
    serveNativeVerb: async (verb, params) =>
      onDevice(async () => {
        if (verb === 'native.storage.read') {
          const { key } = storageReadParamsSchema.parse(params)
          if (!isPageStorageKeyForRoute(key, 'host-a', pathname, hostArea)) {
            throw new Error('host mismatch')
          }
          return { value: disk.get(key) ?? null }
        }
        if (verb === 'native.storage.persist') {
          if (options.oldNative) {
            throw new Error('unknown native verb')
          }
          const { key, expectedValue, value } = storagePersistParamsSchema.parse(params)
          if (!isPageStorageKeyForRoute(key, 'host-a', pathname, hostArea)) {
            throw new Error('host mismatch')
          }
          await compareAndPersistMirrored(key, expectedValue, value)
          if (options.lostAck) {
            throw new Error('acknowledgement lost')
          }
          return {}
        }
        return {}
      })
  })
  await pair.flush()
  const session = pair.client.getShellSession()
  if (session === null) {
    throw new Error('no init')
  }
  publishPageStorage(
    session.storage,
    (key, value) => pair.client.notifyStorageWrite(key, value),
    'host-a',
    pathname,
    session.storageOversize,
    async (key) =>
      storageReadResultSchema.parse(
        (await pair.client.callNativeVerb('native.storage.read', { key })).result
      ).value,
    async (key, expectedValue, value) => {
      storagePersistResultSchema.parse(
        (await pair.client.callNativeVerb('native.storage.persist', { key, expectedValue, value }))
          .result
      )
    },
    hostArea
  )
  async function settled<T>(promise: Promise<T>): Promise<T> {
    const captured = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
    for (let index = 0; index < 100; index++) {
      await pair.flush()
    }
    const result = await captured
    if ('error' in result) {
      throw result.error
    }
    return result.value
  }
  return { pair, settled, session }
}

beforeEach(() => {
  disk.clear()
  adapter.current = null
  nativeWrite.mockImplementation(async (key, value) => {
    disk.set(key, value)
  })
})

describe('Work Item Start native storage bridge', () => {
  it('persists a new workspace from a narrow page without extending ordinary workspace preference scope', async () => {
    const { settled, pair, session } = await bridge({ narrow: true })
    expect(session.ownsHostArea).toBe(false)
    adapter.current = pageAsyncStorage
    const { admitWorkItemStartStorage } = await import('../../tasks/work-item-start-recovery')
    const { mobileWorkItemStartCreateParams } = await import('../../tasks/work-item-start-delivery')
    await settled(
      admitWorkItemStartStorage('host-a', mobileWorkItemStartCreateParams('', 'codex', 'url'))
    )
    const key = workItemStartCreateStorageKey('host-a', 'new-workspace')
    await settled(pageAsyncStorage.getItem(key))
    await settled(pageAsyncStorage.setItem(key, 'saved identity'))
    expect(disk.get(key)).toBe('saved identity')
    await pageAsyncStorage.setItem('orca:nativeChatTabs:host-a:other-workspace', '{}')
    await pair.flush()
    expect(pair.storageWrites).toEqual([])
    expect(disk.has('orca:nativeChatTabs:host-a:other-workspace')).toBe(false)
  })
  it('persists 70 workspace identities on demand outside the 32-entry snapshot and blocks a repeated confirmed workspace', async () => {
    const { deliverMobileWorkItemStart, mobileWorkItemStartCreateParams } =
      await import('../../tasks/work-item-start-delivery')
    const legacyKey = 'orca:mobileWorkItemStartCreates:v1'
    const legacy = JSON.stringify({
      v: 1,
      creates: Array.from({ length: 64 }, (_, index) => ({
        worktreeId: `old-${index}`,
        confirmed: true,
        params: mobileWorkItemStartCreateParams(`old-${index}`, 'codex', 'url')
      }))
    })
    disk.set(legacyKey, legacy)
    const { settled, session } = await bridge()
    adapter.current = pageAsyncStorage
    const { createFakeRpcClient } = await import('../bridge-host-test-fakes')
    let creates = 0
    const client: RpcClient = {
      ...createFakeRpcClient(),
      sendRequest: async (method, input) => {
        if (method === 'agentSession.createSupport') {
          return { id: method, ok: true, result: { supported: true } }
        }
        const params = CreateIntentParams.parse(input)
        expect(disk.has(workItemStartCreateStorageKey('host-a', params.worktree.slice(3)))).toBe(
          true
        )
        creates++
        return {
          id: method,
          ok: true,
          result: { ok: true, value: { sessionId: params.envelope.sessionId } }
        }
      }
    }
    for (let index = 0; index < 70; index++) {
      await expect(
        settled(
          deliverMobileWorkItemStart({
            client,
            hostId: 'host-a',
            worktreeId: `workspace-${index}`,
            agent: 'codex',
            prompt: 'url'
          })
        )
      ).resolves.toBeUndefined()
    }
    expect(creates).toBe(70)
    expect(session.storageOversize).toContain(legacyKey)
    expect(disk.get(legacyKey)).toBe(legacy)
    expect(Object.keys(session.storage).length).toBeLessThanOrEqual(PAGE_STORAGE_MAX_ENTRIES)
    expect(
      Object.keys(session.storage).some((key) => key.includes('mobileWorkItemStartCreate:'))
    ).toBe(false)
    const repeat = await bridge()
    await expect(
      repeat.settled(
        deliverMobileWorkItemStart({
          client,
          hostId: 'host-a',
          worktreeId: 'workspace-0',
          agent: 'codex',
          prompt: 'another url'
        })
      )
    ).resolves.toContain('already created')
    expect(creates).toBe(70)
  })

  it.each(['old-native', 'native-failure', 'lost-ack'] as const)(
    'prevents workspace effects with %s even if readback could see a value',
    async (failure) => {
      if (failure === 'native-failure') {
        nativeWrite.mockRejectedValue(new Error('native disk failed'))
      }
      const { settled } = await bridge({
        oldNative: failure === 'old-native',
        lostAck: failure === 'lost-ack'
      })
      adapter.current = pageAsyncStorage
      const { createWorkspaceFromComposerSource } =
        await import('../../tasks/source-workspace-create')
      const { createFakeRpcClient } = await import('../bridge-host-test-fakes')
      const methods: string[] = []
      const client = {
        ...createFakeRpcClient(),
        sendRequest: async (method: string) => {
          methods.push(method)
          const result =
            method === 'settings.get'
              ? { settings: { workItemStartPromptDelivery: 'submit-after-ready' } }
              : method === 'status.get'
                ? {
                    capabilities: [
                      'agent-session.work-item-start.v1',
                      AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
                    ]
                  }
                : { supported: true }
          return { id: method, ok: true as const, result }
        }
      }
      await expect(
        settled(
          createWorkspaceFromComposerSource({
            client,
            hostId: 'host-a',
            targetRepoId: 'repo',
            selection: {
              kind: 'work-item',
              item: {
                provider: 'github',
                type: 'issue',
                repoId: 'repo',
                number: 79,
                title: 'Start',
                url: 'url'
              }
            },
            setupDecision: 'skip',
            agent: { choice: 'codex' },
            workspaceName: undefined,
            note: undefined,
            worktreeCreateIdempotency: false,
            agentLaunchSupported: false
          })
        )
      ).rejects.toThrow()
      expect(methods).not.toContain('worktree.create')
      expect(methods).not.toContain('agentSession.create')
      if (failure === 'lost-ack') {
        expect(disk.size).toBe(1)
      }
    }
  )

  it('rejects missing ACK capability and a foreign host before a journal can appear persisted', async () => {
    publishPageStorage({}, () => true, 'host-a', '/h/host-a')
    await expect(
      pageAsyncStorage.setItem('orca:mobileWorkItemStartAdmission:host-a', '{"v":1}')
    ).rejects.toThrow()
    const { settled } = await bridge()
    await expect(
      settled(pageAsyncStorage.setItem(workItemStartCreateStorageKey('host-b', 'workspace'), '{}'))
    ).rejects.toThrow()
    expect(disk.size).toBe(0)
  })

  it('does not replace a concurrent writer identity in native persistence', async () => {
    const { settled } = await bridge()
    const key = workItemStartCreateStorageKey('host-a', 'pending')
    await settled(pageAsyncStorage.getItem(key))
    disk.set(key, 'original unknown identity')
    await expect(settled(pageAsyncStorage.setItem(key, 'replacement'))).rejects.toThrow()
    expect(disk.get(key)).toBe('original unknown identity')
  })

  it('accepts only one of two native compare-and-persist attempts for the same workspace', async () => {
    const key = workItemStartCreateStorageKey('host-a', 'race')
    const results = await Promise.allSettled([
      compareAndPersistMirrored(key, null, 'original'),
      compareAndPersistMirrored(key, null, 'replacement')
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(disk.get(key)).toBe('original')
  })

  it('reads a legacy journal larger than 16KiB on demand instead of treating omitted init as absence', async () => {
    const key = 'orca:mobileWorkItemStartCreates:v1'
    const raw = 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1)
    disk.set(key, raw)
    const { settled, session } = await bridge()
    expect(session.storage[key]).toBeUndefined()
    expect(session.storageOversize).toContain(key)
    await expect(settled(pageAsyncStorage.getItem(key))).resolves.toBe(raw)
    expect(disk.get(key)).toBe(raw)
  })
})
