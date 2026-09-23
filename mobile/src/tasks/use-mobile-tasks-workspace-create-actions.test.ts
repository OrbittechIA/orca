import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import type { WorkspaceSshStateModel } from './use-mobile-tasks-workspace-ssh-state'
import { useMobileTasksWorkspaceCreateActions } from './use-mobile-tasks-workspace-create-actions'

// Keep the real launch decisions while avoiding the native screen barrel in this hook test.
vi.mock('./mobile-tasks-dependencies', async () => ({
  useCallback: (await import('react')).useCallback,
  ...(await import('./workspace-agent-selection')),
  ...(await import('./workspace-create-params')),
  ...(await import('./workspace-create-timeout')),
  ...(await import('./setup-hook-trust')),
  ...(await import('./hosted-review-start-point'))
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const item: ActionableTaskItem = {
  key: 'issue-58',
  provider: 'github',
  title: 'Fix Start',
  subtitle: '',
  status: 'open',
  updatedAt: '',
  source: {
    id: '58',
    type: 'issue',
    number: 58,
    title: 'Fix Start',
    state: 'open',
    url: 'https://github.com/OrbittechIA/orca/issues/58',
    labels: [],
    updatedAt: '',
    author: null,
    repoId: 'repo-1',
    repoName: 'orca'
  }
}
function reply(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}
let renderer: ReactTestRenderer | null = null
let actions: ReturnType<typeof useMobileTasksWorkspaceCreateActions> | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  actions = null
})

async function submit(settings: unknown) {
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string) => {
    if (method === 'settings.get') {
      return reply({ settings })
    }
    if (method === 'status.get') {
      return reply({ capabilities: [], deviceScope: 'runtime' })
    }
    if (method === 'worktree.create') {
      return reply({ worktree: { id: 'wt-1', displayName: 'Fix Start' } })
    }
    throw new Error(`Unexpected request ${method}`)
  })
  const model = {
    client,
    ensureWorkspaceSshReady: vi.fn(async () => undefined),
    getWorkspaceTargetRepo: () => ({ id: 'repo-1', displayName: 'Orca', path: '/repo' }),
    hostId: 'host-1',
    resolveCreateSetupDecision: vi.fn(async () => ({ kind: 'resolved', decision: 'skip' })),
    router: { push: vi.fn() },
    runtimeTaskSettings: { workItemStartPromptDelivery: 'submit-after-ready' },
    setActionItem: vi.fn(),
    setCreatingKey: vi.fn(),
    setError: vi.fn(),
    setOrcaYamlTrustPrompt: vi.fn(),
    setRuntimeTaskSettings: vi.fn(),
    setSetupPrompt: vi.fn(),
    setWorkspaceAgent: vi.fn(),
    setWorkspaceAgentOverridden: vi.fn(),
    setWorkspaceCreateDraft: vi.fn(),
    taskStateHydrated: true,
    tasksSupported: true,
    trustedOrcaHooks: {},
    workspaceDetectedAgentIds: null,
    workspaceLastAutoName: ''
  }
  function Harness() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all fields consumed by the create hook are supplied; unrelated screen state is omitted.
    actions = useMobileTasksWorkspaceCreateActions(model as unknown as WorkspaceSshStateModel)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
  if (!actions) {
    throw new Error('Hook not mounted')
  }
  const current = actions
  await act(async () => current.createWorkspace(item, undefined, undefined, 'codex'))
  return { client, model }
}

describe('Tasks Start settings refresh', () => {
  it.each([undefined, null, false, 'invalid', [], {}, { workItemStartPromptDelivery: 'invalid' }])(
    'keeps strict admission after an incomplete settings refresh: %j',
    async (settings) => {
      const { client, model } = await submit(settings)
      expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
        'settings.get',
        'status.get'
      ])
      expect(model.setError).toHaveBeenLastCalledWith(
        expect.stringContaining('Nothing was created')
      )
      expect(model.resolveCreateSetupDecision).not.toHaveBeenCalled()
      expect(model.router.push).not.toHaveBeenCalled()
      expect(model.setCreatingKey).toHaveBeenLastCalledWith(null)
    }
  )

  it('accepts an explicit refreshed Draft preference on an old host', async () => {
    const { client, model } = await submit({ workItemStartPromptDelivery: 'draft' })
    expect(client.sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'settings.get',
      'worktree.create'
    ])
    expect(client.sendRequest).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ startupDraft: item.source.url }),
      expect.any(Object)
    )
    expect(model.setError).toHaveBeenCalledExactlyOnceWith('')
    expect(model.router.push).toHaveBeenCalledOnce()
  })
})
