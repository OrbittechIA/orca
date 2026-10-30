import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { CreateIntentParams } from '../../../src/shared/rpc-contract/structured-agent-session-params'
import { deliverMobileWorkItemStart, mobileWorkItemStartCreateParams } from './work-item-start-delivery'
import { admitWorkItemStartStorage, readWorkItemStartRecovery } from './work-item-start-recovery'
import { workItemStartCreateStorageKey } from '../storage/work-item-start-storage-key'

const disk = vi.hoisted(() => new Map<string, string>())
const write = vi.hoisted(() => vi.fn(async (key: string, value: string) => { disk.set(key, value) }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => disk.get(key) ?? null,
  setItem: write
} }))
const hostId = 'host-a'
const legacyKey = 'orca:mobileWorkItemStartCreates:v1'

function clientFor(outcome: 'success' | 'unknown' = 'success') {
  const creates: ReturnType<typeof CreateIntentParams.parse>[] = []
  return { creates, client: {
    ...createFakeRpcClient(),
    sendRequest: vi.fn(async (method: string, input?: unknown) => {
      if (method === 'agentSession.createSupport') return { id: 'support', ok: true as const, result: { supported: true } }
      if (method !== 'agentSession.create') throw new Error(`Unexpected ${method}`)
      const params = CreateIntentParams.parse(input)
      expect(JSON.parse(disk.get(workItemStartCreateStorageKey(hostId, params.worktree.slice(3))) ?? 'null')).toMatchObject({ confirmed: false, params })
      creates.push(params)
      if (outcome === 'unknown') throw new Error('acknowledgement lost')
      return { id: 'create', ok: true as const, result: { ok: true, value: { sessionId: params.envelope.sessionId } } }
    })
  } }
}

beforeEach(() => {
  disk.clear()
  write.mockClear()
  write.mockImplementation(async (key, value) => { disk.set(key, value) })
})

describe('Work Item Start durable workspace recovery', () => {
  it('serializes 70 concurrent workspaces without replacing a held unknown identity', async () => {
    const unknown = clientFor('unknown')
    await deliverMobileWorkItemStart({ client: unknown.client, hostId, worktreeId: 'held', agent: 'codex', prompt: 'original' })
    const held = disk.get(workItemStartCreateStorageKey(hostId, 'held'))
    const { client, creates } = clientFor()
    await Promise.all(Array.from({ length: 70 }, (_, index) => deliverMobileWorkItemStart({ client, hostId, worktreeId: `parallel-${index}`, agent: 'codex', prompt: 'url' })))
    expect(creates).toHaveLength(70)
    expect(new Set(creates.map((params) => params.envelope.sessionId)).size).toBe(70)
    expect(disk.get(workItemStartCreateStorageKey(hostId, 'held'))).toBe(held)
    for (let index = 0; index < 70; index++) expect(await readWorkItemStartRecovery(`parallel-${index}`, hostId)).toEqual({ kind: 'confirmed' })
  })
  it('admits 70 confirmed Starts, and a confirmed workspace cannot send again after reload', async () => {
    const { client, creates } = clientFor()
    for (let index = 0; index < 70; index++) {
      const worktreeId = `workspace-${index}`
      await expect(deliverMobileWorkItemStart({ client, hostId, worktreeId, agent: 'codex', prompt: `issue-${index}` })).resolves.toBeUndefined()
      expect(await readWorkItemStartRecovery(worktreeId, hostId)).toEqual({ kind: 'confirmed' })
    }
    expect(creates).toHaveLength(70)
    const tombstones = new Map(disk)
    vi.resetModules()
    const reloaded = await import('./work-item-start-delivery')
    expect(await reloaded.deliverMobileWorkItemStart({ client, hostId, worktreeId: 'workspace-0', agent: 'codex', prompt: 'another issue' })).toContain('already created')
    expect(creates).toHaveLength(70)
    expect(disk).toEqual(tombstones)
    expect([...disk.values()].every((raw) => raw.length < 1024)).toBe(true)
  })

  it('leaves a full v1 journal and all 224 journals byte for byte, and uses new workspace storage', async () => {
    const entries = Array.from({ length: 64 }, (_, index) => ({ worktreeId: `old-${index}`, confirmed: true, params: mobileWorkItemStartCreateParams(`old-${index}`, 'codex', 'url') }))
    const raw = JSON.stringify({ v: 1, creates: entries })
    const attempts = '{ "v":1, "attempts":[{"worktreeId":"224-unknown","sessionId":"original","sendClientOperationId":"original-send"}] }'
    const identities = '{ "v":1, "identities":[] }'
    disk.set(legacyKey, raw)
    disk.set('orca:mobileWorkItemStartAttempts:v1', attempts)
    disk.set('orca:mobileWorkItemStartSendIdentities:v1', identities)
    const { client, creates } = clientFor()
    await expect(deliverMobileWorkItemStart({ client, hostId, worktreeId: 'new', agent: 'codex', prompt: 'url' })).resolves.toBeUndefined()
    expect(await deliverMobileWorkItemStart({ client, hostId, worktreeId: 'old-0', agent: 'codex', prompt: 'new url' })).toContain('already created')
    expect(await deliverMobileWorkItemStart({ client, hostId, worktreeId: '224-unknown', agent: 'codex', prompt: 'new url' })).toContain('earlier')
    expect(creates).toHaveLength(1)
    expect(disk.get(legacyKey)).toBe(raw)
    expect(disk.get('orca:mobileWorkItemStartAttempts:v1')).toBe(attempts)
    expect(disk.get('orca:mobileWorkItemStartSendIdentities:v1')).toBe(identities)
  })

  it('preserves unknown and concurrent identities without opening another create', async () => {
    const { client, creates } = clientFor('unknown')
    const args = { client, hostId, worktreeId: 'unknown', agent: 'codex', prompt: 'url' }
    await Promise.allSettled([deliverMobileWorkItemStart(args), deliverMobileWorkItemStart(args)])
    expect(creates).toHaveLength(2)
    expect(creates[0]).toEqual(creates[1])
    const held = disk.get(workItemStartCreateStorageKey(hostId, 'unknown'))
    vi.resetModules()
    const reloaded = await import('./work-item-start-delivery')
    expect(await reloaded.deliverMobileWorkItemStart(args)).toContain('unconfirmed')
    expect(creates).toHaveLength(2)
    expect(disk.get(workItemStartCreateStorageKey(hostId, 'unknown'))).toBe(held)
    expect(await readWorkItemStartRecovery('unknown', hostId)).toEqual({ kind: 'create', params: creates[0] })
  })

  it.each(['reject', 'drop'] as const)('prevents the first create when storage writes %s', async (failure) => {
    write.mockImplementation(async () => { if (failure === 'reject') throw new Error('disk unavailable') })
    const { client, creates } = clientFor()
    await expect(deliverMobileWorkItemStart({ client, hostId, worktreeId: 'no-disk', agent: 'codex', prompt: 'url' })).rejects.toThrow()
    expect(creates).toEqual([])
    expect(client.sendRequest).not.toHaveBeenCalled()
    await expect(admitWorkItemStartStorage(hostId, mobileWorkItemStartCreateParams('', 'codex', 'url'))).rejects.toThrow()
  })

  it('keeps a pending identity when confirmation fails after a successful create', async () => {
    const { client, creates } = clientFor()
    write.mockImplementation(async (key, value) => {
      if (value.includes('"confirmed":true')) throw new Error('confirmation failed')
      disk.set(key, value)
    })
    const args = { client, hostId, worktreeId: 'pending', agent: 'codex', prompt: 'url' }
    await expect(deliverMobileWorkItemStart(args)).rejects.toThrow('confirmation failed')
    expect(await deliverMobileWorkItemStart(args)).toContain('unconfirmed')
    expect(creates).toHaveLength(1)
    expect(await readWorkItemStartRecovery('pending', hostId)).toEqual({ kind: 'create', params: creates[0] })
  })

  it('does not send to a host that changes while the original identity is being saved', async () => {
    const { client, creates } = clientFor()
    let generation = 0
    const migrating = { ...client, getGeneration: () => generation }
    write.mockImplementation(async (key, value) => {
      disk.set(key, value)
      generation++
    })
    expect(await deliverMobileWorkItemStart({ client: migrating, hostId, worktreeId: 'migrated', agent: 'codex', prompt: 'url' })).toContain('connection changed')
    expect(creates).toHaveLength(0)
    expect(await readWorkItemStartRecovery('migrated', hostId)).toMatchObject({ kind: 'create' })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })
})
