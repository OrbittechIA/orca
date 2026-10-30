import '../unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CreateSupportParams } from './structured-agent-session-schemas'
import { agentSessionRecordFixture } from '../../../../shared/agent-session-record.test-fixture'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { call, hostStub, hostCalls, SESSION, STRUCTURED_CLIENT } from './structured-agent-session-rpc.test-fixture'

const owner = { ...STRUCTURED_CLIENT, caller: { kind: 'paired-device', deviceId: 'owner' } } as const
const foreign = { ...STRUCTURED_CLIENT, caller: { kind: 'paired-device', deviceId: 'foreign' } } as const
const preflight = { repo: 'id:repo-1', agent: 'codex', launchOrigin: 'work-item-start' } as const

beforeEach(() => {
  const host = hostStub()
  vi.spyOn(host.deps.store, 'getRecord').mockReturnValue({
    ...agentSessionRecordFixture(), sessionId: SESSION,
    launchOrigin: 'work-item-start', launchAuthority: { kind: 'paired-device', deviceId: 'owner' }
  })
  setStructuredAgentSessionHost(host)
})
afterEach(() => setStructuredAgentSessionHost(null))

it.each(['agentSession.history', 'agentSession.options', 'agentSession.close', 'agentSession.release', 'agentSession.unsubscribe'])('admits only the persisted owner for %s', async (method) => {
  const params = { sessionId: SESSION, ...(method === 'agentSession.release' ? { holderId: 'holder' } : {}) }
  expect(await call(method, params, owner)).toMatchObject({ ok: true })
  expect(await call(method, params, foreign)).toMatchObject({ ok: false })
})

it('accepts exactly one pre-create selector and no authority claims', () => {
  expect(CreateSupportParams.safeParse(preflight).success).toBe(true)
  for (const input of [
    { ...preflight, worktree: 'id:workspace-1' },
    { repo: preflight.repo, agent: preflight.agent },
    { ...preflight, launchAuthority: owner.caller },
    { ...preflight, clientOrigin: 'desktop' }
  ]) expect(CreateSupportParams.safeParse(input).success).toBe(false)
})

it('refuses unproved pre-create callers before reading the repository or creating a workspace', async () => {
  const getWorkItemStartPreCreateSupport = vi.fn(async () => ({ supported: true }))
  const createWorktree = vi.fn()
  const runtime = { getWorkItemStartPreCreateSupport, createWorktree }
  for (const client of [STRUCTURED_CLIENT, { ...STRUCTURED_CLIENT, caller: { kind: 'local-cli' as const } }]) {
    expect(await call('agentSession.createSupport', preflight, client, runtime)).toMatchObject({ ok: false })
  }
  expect(getWorkItemStartPreCreateSupport).not.toHaveBeenCalled()
  expect(createWorktree).not.toHaveBeenCalled()
  expect(await call('agentSession.createSupport', preflight, owner, runtime)).toMatchObject({ ok: true, result: { supported: true } })
  expect(getWorkItemStartPreCreateSupport).toHaveBeenCalledWith('id:repo-1', 'codex')
  expect(createWorktree).not.toHaveBeenCalled()
  expect(hostCalls.attach).not.toHaveBeenCalled()
})
