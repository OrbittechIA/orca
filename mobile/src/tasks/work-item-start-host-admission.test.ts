import '../../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  call,
  hostStub
} from '../../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { ordinaryStructuredSessionStoreFixture } from '../../../src/main/runtime/rpc/methods/structured-agent-session-rpc-client.test-fixture'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../transport/mobile-runtime-client-capabilities'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { createWorkspaceFromComposerSource } from './source-workspace-create'
import { useMobileTasksWorkspaceCreateActions } from './use-mobile-tasks-workspace-create-actions'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    }
  }
}))
vi.mock('./mobile-tasks-dependencies', async () => ({
  useCallback: (callback: unknown) => callback,
  ...(await import('./workspace-agent-selection')),
  ...(await import('./setup-hook-trust')),
  ...(await import('./workspace-create-params')),
  ...(await import('./hosted-review-start-point')),
  ...(await import('./workspace-create-timeout'))
}))

const caller = {
  clientKind: 'mobile',
  clientCapabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES,
  caller: { kind: 'paired-device', deviceId: 'owner' }
} as const
const target = {
  worktreeId: 'workspace-1',
  workspacePath: '/workspace',
  instanceId: null,
  identityKey: null,
  executionHostId: 'local',
  creatorKind: 'paired-device',
  creatorDeviceId: 'owner'
} as const
const hostSettings = { experimentalNativeChat: false, defaultTuiAgent: 'codex' }
const runtime = {
  getClientSettings: () => hostSettings,
  requireStore: () => ({ getSettings: () => hostSettings }),
  getWorkItemStartPreCreateSupport: async () => ({ supported: true }),
  resolveStructuredAgentSessionCreateWorktreeTarget: async () => target
}
const issue = {
  id: 'issue:79',
  type: 'issue' as const,
  number: 79,
  title: 'Start',
  url: 'https://example.com/79',
  repoId: 'repo',
  repoName: 'repo',
  state: 'open',
  labels: [],
  author: null,
  updatedAt: ''
}
let host: StructuredAgentSessionHost

beforeEach(() => {
  disk.clear()
  const base = hostStub()
  Object.assign(base.deps.store, ordinaryStructuredSessionStoreFixture([]))
  host = {
    ...base,
    create: vi.fn<StructuredAgentSessionHost['create']>(async (owner, params) => {
      const attached = await base.attach(owner, params)
      return attached.ok
        ? { ...attached, value: { ...attached.value, sessionId: params.envelope.sessionId } }
        : attached
    })
  }
  setStructuredAgentSessionHost(host)
})
afterEach(() => setStructuredAgentSessionHost(null))

function policyClient(delivery = 'submit-after-ready') {
  const workspaces: unknown[] = []
  return {
    workspaces,
    client: {
      ...createFakeRpcClient(),
      sendRequest: async (method: string, params?: unknown) => {
        if (method.startsWith('agentSession.')) {
          return call(method, params, caller, runtime)
        }
        const result =
          method === 'settings.get'
            ? { settings: { workItemStartPromptDelivery: delivery } }
            : method === 'status.get'
              ? {
                  capabilities: [
                    'agent-session.work-item-start.v1',
                    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
                  ]
                }
              : { worktree: { id: target.worktreeId, displayName: 'Start' } }
        if (method === 'worktree.create') {
          workspaces.push(params)
        }
        return { id: method, ok: true as const, result }
      }
    }
  }
}

describe('mobile Start with the real dispatcher admission and mobile capabilities', () => {
  it.each(['composer', 'tasks'] as const)(
    'preserves explicit origin after %s creates the workspace while the host default is terminal',
    async (entrypoint) => {
      const { client, workspaces } = policyClient()
      if (entrypoint === 'composer') {
        const result = await createWorkspaceFromComposerSource({
          client,
          hostId: 'host-a',
          selection: { kind: 'work-item', item: { provider: 'github', ...issue } },
          targetRepoId: 'repo',
          setupDecision: 'skip',
          agent: { choice: 'codex' },
          workspaceName: undefined,
          note: undefined,
          worktreeCreateIdempotency: false,
          agentLaunchSupported: false
        })
        expect(result).not.toHaveProperty('warning')
      } else {
        const noop = () => {}
        const errors: string[] = []
        const model: Parameters<typeof useMobileTasksWorkspaceCreateActions>[0] = {
          client,
          hostId: 'host-a',
          tasksSupported: true,
          taskStateHydrated: true,
          runtimeTaskSettings: {},
          trustedOrcaHooks: {},
          repos: [],
          workspaceDetectedAgentIds: null,
          workspaceLastAutoName: '',
          router: { push: noop },
          getWorkspaceTargetRepo: () => ({ id: 'repo', displayName: 'repo', path: '/workspace' }),
          ensureWorkspaceSshReady: async () => {},
          resolveCreateSetupDecision: async () => ({ kind: 'decision', decision: 'skip' }),
          setActionItem: noop,
          setCreatingKey: noop,
          setError: (update) => {
            errors.push(typeof update === 'function' ? update(errors.at(-1) ?? '') : update)
          },
          setOrcaYamlTrustPrompt: noop,
          setRuntimeTaskSettings: noop,
          setSetupPrompt: noop,
          setWorkspaceAgent: noop,
          setWorkspaceAgentOverridden: noop,
          setWorkspaceCreateDraft: noop
        }
        await useMobileTasksWorkspaceCreateActions(model).createWorkspace(
          {
            key: 'issue',
            provider: 'github',
            title: issue.title,
            subtitle: '',
            status: 'Open',
            updatedAt: '',
            source: issue
          },
          undefined,
          undefined,
          'codex'
        )
        expect(errors.filter(Boolean)).toEqual([])
      }
      expect(workspaces).toHaveLength(1)
      expect(workspaces[0]).not.toHaveProperty('startupDraft')
      expect(host.create).toHaveBeenCalledTimes(1)
      expect(host.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ launchOrigin: 'work-item-start' }),
        expect.objectContaining({
          firstMessage: expect.objectContaining({
            body: expect.objectContaining({ blocks: [{ type: 'text', text: issue.url }] })
          })
        })
      )
    }
  )

  it('keeps an ordinary probe subject to the terminal preference and does not create', async () => {
    const { client } = policyClient()
    await expect(
      createMobileStructuredAgentSession(client, target.worktreeId, 'codex')
    ).resolves.toEqual({ kind: 'unsupported' })
    expect(host.create).not.toHaveBeenCalled()
  })

  it('keeps Draft on its prior workspace startup path without requiring durable Start storage', async () => {
    const { client, workspaces } = policyClient('draft')
    await expect(
      createWorkspaceFromComposerSource({
        client,
        selection: { kind: 'work-item', item: { provider: 'github', ...issue } },
        targetRepoId: 'repo',
        setupDecision: 'skip',
        agent: { choice: 'codex' },
        workspaceName: undefined,
        note: undefined,
        worktreeCreateIdempotency: false,
        agentLaunchSupported: false
      })
    ).resolves.toMatchObject({ worktreeId: target.worktreeId })
    expect(workspaces[0]).toHaveProperty('startupDraft')
    expect(disk.size).toBe(0)
    expect(host.create).not.toHaveBeenCalled()
  })
})
