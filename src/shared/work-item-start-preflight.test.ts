import { describe, expect, it, vi } from 'vitest'
import { preflightWorkItemStart } from './work-item-start-preflight'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from './agent-session-create-capabilities'
const WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY = 'agent-session.work-item-start.v1'

const capabilities = [WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY, AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY]
const input = {
  delivery: 'submit-after-ready', agent: 'codex', repoId: 'repo-1', mobile: true,
  readStatus: async () => ({ capabilities, deviceScope: 'runtime' }),
  readSupport: async () => ({ supported: true })
}

describe('Work Item Start before workspace effects', () => {
  it.each([undefined, null, 'draft', 'unexpected', true])('keeps %s manual without probing', async (delivery) => {
    const readStatus = vi.fn(() => { throw new Error('must not probe') })
    expect(await preflightWorkItemStart({ ...input, delivery, readStatus })).toEqual({ kind: 'manual' })
    expect(readStatus).not.toHaveBeenCalled()
  })
  it.each([[], [capabilities[0]], [capabilities[1]]])('refuses a host missing either contract (%j)', async (caps) => {
    const readSupport = vi.fn(input.readSupport)
    expect(await preflightWorkItemStart({ ...input, readStatus: async () => ({ capabilities: caps, deviceScope: 'runtime' }), readSupport })).toMatchObject({ kind: 'refused' })
    expect(readSupport).not.toHaveBeenCalled()
  })
  it('keeps a timed out answer distinct from refusal', async () => {
    expect(await preflightWorkItemStart({ ...input, readSupport: async () => { throw new Error('timeout') } })).toMatchObject({ kind: 'unknown' })
    expect(await preflightWorkItemStart({ ...input, readSupport: async () => ({ supported: false }) })).toMatchObject({ kind: 'refused' })
  })
  it('asks the scoped repo contract only after host scope is confirmed', async () => {
    const readSupport = vi.fn(input.readSupport)
    expect(await preflightWorkItemStart({ ...input, readSupport })).toEqual({ kind: 'structured' })
    expect(readSupport).toHaveBeenCalledWith({ repo: 'id:repo-1', agent: 'codex', launchOrigin: 'work-item-start' })
    expect(await preflightWorkItemStart({ ...input, readStatus: async () => ({ capabilities, deviceScope: 'mobile' }) })).toMatchObject({ kind: 'refused' })
  })
})
