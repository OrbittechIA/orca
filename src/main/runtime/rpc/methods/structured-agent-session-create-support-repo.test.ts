import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateSupportParams } from './structured-agent-session-schemas'
import {
  call,
  clearStructuredHostStub,
  installStructuredHostStub,
  runtimeCalls,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

// A strict Work Item Start asks about the SOURCE repo before `worktree.create`, so a refusal
// lands while nothing exists yet.

const REPO_FIELDS = {
  repo: 'id:repo-1',
  agent: 'codex' as const,
  launchOrigin: 'work-item-start' as const
}

const ADMITTED_CLIENT = { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-1' }

const STRICT_SETTINGS = {
  getClientSettings: () => ({ workItemStartPromptDelivery: 'submit-after-ready' })
}

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.createSupport repo params', () => {
  it.each([
    ['a worktree probe', { worktree: 'id:wt-1', agent: 'codex' }, true],
    ['a repo probe with launchOrigin', REPO_FIELDS, true],
    ['a repo probe without launchOrigin', { repo: 'id:repo-1', agent: 'codex' }, false],
    ['a repo and a worktree', { ...REPO_FIELDS, worktree: 'id:wt-1' }, false],
    ['a repo and a session', { ...REPO_FIELDS, sessionId: 'codex_s1' }, false],
    ['neither selector', { agent: 'codex' }, false]
  ])('accepts %s: %s', (_label, params, accepted) => {
    expect(CreateSupportParams.safeParse(params).success).toBe(accepted)
  })
})

describe('agentSession.createSupport pre-create verdict', () => {
  it.each([
    [{ supported: true }],
    [{ supported: false, reason: 'wsl' }],
    [{ supported: false, reason: 'remote' }],
    [{ supported: false, reason: 'agent' }]
  ])('returns the runtime repo verdict %j', async (verdict) => {
    const getWorkItemStartPreCreateSupport = vi.fn(async () => verdict)
    const response = await call('agentSession.createSupport', REPO_FIELDS, ADMITTED_CLIENT, {
      ...STRICT_SETTINGS,
      getWorkItemStartPreCreateSupport
    })
    expect(response).toMatchObject({ ok: true, result: verdict })
    expect(getWorkItemStartPreCreateSupport).toHaveBeenCalledWith('id:repo-1', 'codex')
    expect(runtimeCalls.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it.each([
    [
      'draft mode',
      { getClientSettings: () => ({ workItemStartPromptDelivery: 'draft' }) },
      ADMITTED_CLIENT
    ],
    [
      'a mobile-scoped caller',
      STRICT_SETTINGS,
      { ...ADMITTED_CLIENT, clientKind: 'mobile' as const }
    ]
  ])('refuses the repo probe in %s without reading the repo', async (_label, settings, client) => {
    const getWorkItemStartPreCreateSupport = vi.fn(async () => ({ supported: true }))
    const response = await call('agentSession.createSupport', REPO_FIELDS, client, {
      ...settings,
      getWorkItemStartPreCreateSupport
    })
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(getWorkItemStartPreCreateSupport).not.toHaveBeenCalled()
  })
})
