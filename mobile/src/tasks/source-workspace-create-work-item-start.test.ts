import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { createWorkspaceFromComposerSource } from './source-workspace-create'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { workItemStartCreateStorageKey } from '../storage/work-item-start-storage-key'
const WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY = 'agent-session.work-item-start.v1'

const saved = vi.hoisted(() => new Map<string, string>())
const save = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    saved.set(key, value)
  })
)
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: save
  }
}))

const args = {
  selection: {
    kind: 'work-item' as const,
    item: {
      provider: 'github' as const,
      type: 'issue' as const,
      repoId: 'repo',
      number: 79,
      title: 'Start',
      url: 'https://example.com/79'
    }
  },
  hostId: 'host-a',
  targetRepoId: 'repo',
  setupDecision: 'skip' as const,
  agent: { choice: 'codex' as const },
  workspaceName: undefined,
  note: undefined,
  worktreeCreateIdempotency: false as const,
  agentLaunchSupported: false as const
}

beforeEach(() => {
  saved.clear()
  save.mockImplementation(async (key, value) => {
    saved.set(key, value)
  })
})

describe('composer Work Item Start admission and first message', () => {
  it.each(['failed-write', 'dropped-write', 'oversized-prompt'])(
    'prevents workspace creation when storage admission detects %s',
    async (failure) => {
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
                      WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY,
                      AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
                    ]
                  }
                : { supported: true }
          return { id: method, ok: true as const, result }
        }
      }
      if (failure === 'failed-write') save.mockRejectedValueOnce(new Error('native write failed'))
      if (failure === 'dropped-write') save.mockImplementationOnce(async () => {})
      const selection =
        failure === 'oversized-prompt'
          ? { ...args.selection, item: { ...args.selection.item, url: 'x'.repeat(16 * 1024) } }
          : args.selection
      await expect(
        createWorkspaceFromComposerSource({ ...args, selection, client })
      ).rejects.toThrow()
      expect(methods).not.toContain('worktree.create')
      expect(methods).not.toContain('agentSession.create')
    }
  )
  it('refuses an old host before creating a workspace', async () => {
    const methods: string[] = []
    const client = {
      ...createFakeRpcClient(),
      sendRequest: async (method: string) => {
        methods.push(method)
        return {
          id: method,
          ok: true as const,
          result:
            method === 'settings.get'
              ? { settings: { workItemStartPromptDelivery: 'submit-after-ready' } }
              : { capabilities: [] }
        }
      }
    }
    await expect(createWorkspaceFromComposerSource({ ...args, client })).rejects.toThrow()
    expect(methods).toEqual(['settings.get', 'status.get'])
  })
  it('saves one envelope and replays it after a lost create acknowledgement without a separate send', async () => {
    const methods: string[] = []
    const creates: unknown[] = []
    const client = {
      ...createFakeRpcClient(),
      sendRequest: async (method: string, params?: unknown) => {
        methods.push(method)
        if (method === 'agentSession.create') {
          creates.push(params)
          expect(saved.has(workItemStartCreateStorageKey(args.hostId, 'repo::/work/79'))).toBe(true)
          throw new Error('acknowledgement lost')
        }
        const result =
          method === 'settings.get'
            ? { settings: { workItemStartPromptDelivery: 'submit-after-ready' } }
            : method === 'status.get'
              ? {
                  capabilities: [
                    WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY,
                    AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
                  ],
                  deviceScope: 'runtime'
                }
              : method === 'agentSession.createSupport'
                ? { supported: true }
                : { worktree: { id: 'repo::/work/79' } }
        return { id: method, ok: true as const, result }
      }
    }
    const result = await createWorkspaceFromComposerSource({ ...args, client })
    expect(result).toMatchObject({ worktreeId: 'repo::/work/79', warning: expect.any(String) })
    expect(creates).toHaveLength(2)
    expect(creates[0]).toEqual(creates[1])
    expect(creates[0]).toMatchObject({
      launchOrigin: 'work-item-start',
      firstMessage: { body: { blocks: [{ text: args.selection.item.url }] } }
    })
    expect(methods).not.toContain('agentSession.send')
  })
})
