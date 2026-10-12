import { afterEach, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DaemonPtyProcessInspection } from './daemon-pty-process-inspection'
import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import * as evidence from './daemon-incarnation-evidence'
import type { SessionInfo } from './types'

const identity = { pid: 424242, startedAtMs: 123, launchNonce: 'synthetic-daemon' }
const adapters: DaemonPtyAdapter[] = []
afterEach(() => {
  for (const adapter of adapters.splice(0)) {
    adapter.dispose()
  }
  vi.restoreAllMocks()
})
class FixtureAdapter extends DaemonPtyAdapter {
  constructor() {
    super({ socketPath: '/synthetic-only/no-socket', tokenPath: '/synthetic-only/no-token' })
    adapters.push(this)
  }
  override ensureConnected = vi.fn(async (_deadline?: number): Promise<void> => {
    throw new Error('forbidden ensure')
  })
  override publishAuditObservation = vi.fn()
  retry = vi.fn()
  override async withDaemonRetry<T>(_fn: () => Promise<T>): Promise<T> {
    this.retry()
    throw new Error('forbidden retry')
  }
  prepare(connected: boolean, sessions: SessionInfo[] = []) {
    this.exactDaemonIncarnation = { identity }
    this.lastAuthenticatedIdentity = identity
    vi.spyOn(this.client, 'isConnected').mockReturnValue(connected)
    vi.spyOn(this.client, 'getDaemonIdentity').mockReturnValue(identity)
    const request = vi.spyOn(this.client, 'request').mockResolvedValue({ sessions })
    const connect = vi
      .spyOn(this.client, 'ensureConnected')
      .mockRejectedValue(new Error('forbidden connect'))
    return {
      request,
      connect,
      ensure: this.ensureConnected,
      audit: this.publishAuditObservation,
      retry: this.retry
    }
  }
  flight(active: boolean) {
    this.respawnPromise = active ? new Promise(() => {}) : null
  }
}
const observe = (adapter: DaemonPtyAdapter) =>
  adapter.observeMaterialCensus({ deadlineMs: Date.now() + 5000 })
const session: SessionInfo = {
  sessionId: 'fixture-session',
  incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pid: 4242,
  cwd: '/fixture/neighbor',
  state: 'running',
  isAlive: true,
  wslDistro: null,
  shellState: 'ready',
  cols: 80,
  rows: 24,
  createdAt: 0,
  agentSessionOwners: []
}

it('cold exact-gone observation never connects, spawns, retries or publishes audit', async () => {
  const adapter = new FixtureAdapter()
  const spies = adapter.prepare(false)
  vi.spyOn(evidence, 'probeDaemonProcessIdentity').mockResolvedValue({
    state: 'gone',
    reason: 'pid_missing',
    evidenceSources: ['process_signal'],
    exactIncarnation: { identity }
  })
  const result = await observe(adapter)
  expect(result.state).toBe('complete')
  for (const counter of Object.values(spies)) {
    expect(counter).not.toHaveBeenCalled()
  }
})

it('uncertain cold incarnation and in-flight respawn remain unverifiable without connection', async () => {
  const adapter = new FixtureAdapter()
  const spies = adapter.prepare(false)
  vi.spyOn(evidence, 'probeDaemonProcessIdentity').mockResolvedValue({
    state: 'unknown',
    reason: 'inspection_failed',
    evidenceSources: ['process_signal']
  })
  expect((await observe(adapter)).state).toBe('unverifiable')
  adapter.flight(true)
  expect((await observe(adapter)).state).toBe('unverifiable')
  adapter.flight(false)
  expect(spies.connect).not.toHaveBeenCalled()
  expect(spies.request).not.toHaveBeenCalled()
})

it.each([
  { isAlive: false, state: 'exited' as const },
  { pid: null },
  { wslDistro: 'Ubuntu' },
  { agentSessionOwners: undefined },
  { cwd: '' }
])('refuses contradictory or incomplete authenticated inventory %j', async (delta) => {
  const adapter = new FixtureAdapter()
  const spies = adapter.prepare(true, [{ ...session, ...delta }])
  expect((await observe(adapter)).state).toBe('unverifiable')
  expect(spies.request).toHaveBeenCalledOnce()
  expect(spies.ensure).not.toHaveBeenCalled()
  expect(spies.audit).not.toHaveBeenCalled()
})

it('router includes preserved legacy adapters and rejects duplicate identities', async () => {
  const current = new FixtureAdapter(),
    legacy = new FixtureAdapter()
  current.prepare(true, [session])
  legacy.prepare(true, [session])
  const router = new DaemonPtyRouter({ current, legacy: [legacy] })
  expect((await router.observeMaterialCensus({ deadlineMs: Date.now() + 5000 })).state).toBe(
    'unverifiable'
  )
})

it('a spawn epoch change during an authenticated read invalidates its proof', async () => {
  const adapter = new FixtureAdapter()
  const spies = adapter.prepare(true)
  const gate = Promise.withResolvers<{ sessions: SessionInfo[] }>()
  spies.request.mockReturnValueOnce(gate.promise)
  vi.spyOn(DaemonPtyProcessInspection.prototype, 'spawn').mockRejectedValueOnce(
    new Error('fixture spawn stopped')
  )
  const observation = observe(adapter)
  await expect(adapter.spawn({ cwd: '/fixture/neighbor', cols: 80, rows: 24 })).rejects.toThrow(
    'fixture spawn stopped'
  )
  gate.resolve({ sessions: [] })
  expect((await observation).state).toBe('unverifiable')
  expect(spies.retry).not.toHaveBeenCalled()
})

it('rejects one owner claim attached to distinct PTYs', async () => {
  const adapter = new FixtureAdapter()
  const owner = {
    claim: {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'i'.repeat(43),
      worktreeScopeDigest: 'w'.repeat(43),
      agent: 'claude' as const
    },
    generation: 'generation',
    phase: 'live' as const,
    ptyId: session.sessionId,
    surface: {
      worktreeId: 'repo::/fixture/neighbor',
      tabId: 'tab',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      terminalHandle: 'term_fixture'
    }
  }
  expect(isAgentSessionOwnerBinding(owner)).toBe(true)
  adapter.prepare(true, [
    { ...session, agentSessionOwners: [owner] },
    { ...session, sessionId: 'other-pty', agentSessionOwners: [{ ...owner, ptyId: 'other-pty' }] }
  ])
  expect((await observe(adapter)).state).toBe('unverifiable')
})
