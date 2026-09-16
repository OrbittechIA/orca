// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  state: {} as Record<string, unknown>
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  recordWebSessionFocusIntent: vi.fn(),
  resolveWebSessionVisibleTabId: () => undefined
}))
import { runtimeTargetForWorktreeOwner } from './worktree-runtime-owner-target'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

/**
 * `createWorktree` roteia por `settingsForRepoOwner(repoId)`, não pelo foco global. Um repo
 * explícito pode pertencer a outro ambiente, e foi exatamente aí que a sessão nascia num
 * runtime onde a workspace não existe.
 */
function stateWithOwner(
  ownerEnvironmentId: string | undefined,
  activeRuntimeEnvironmentId: string | undefined
): WorktreeRuntimeOwnerState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: null,
    projects: [],
    repos: [{ id: 'repo-1', path: '/repo', connectionId: null }],
    settings: { activeRuntimeEnvironmentId },
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'wt-1',
          repoId: 'repo-1',
          hostId: null,
          ...(ownerEnvironmentId ? { runtimeOwnerEnvironmentId: ownerEnvironmentId } : {})
        }
      ]
    }
  } as unknown as WorktreeRuntimeOwnerState
}

describe('structured session routing follows the worktree owner, not the focus', () => {
  it('keeps the repo owner environment when the global focus points elsewhere', () => {
    // O caso que quebrava: foco em env-2, workspace criada em env-1.
    expect(runtimeTargetForWorktreeOwner(stateWithOwner('env-1', 'env-2'), 'wt-1')).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('routes to the owner environment even with no global focus at all', () => {
    expect(runtimeTargetForWorktreeOwner(stateWithOwner('env-1', undefined), 'wt-1')).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

  it('fails closed when more than one runtime claims the worktree', async () => {
    const { AmbiguousStructuredSessionOwnerError } = await import('./worktree-runtime-owner-target')
    const ambiguous = {
      ...stateWithOwner('env-1', 'env-2'),
      worktreesByRepo: {
        'repo-a': [
          { id: 'wt-1', repoId: 'repo-a', hostId: null, runtimeOwnerEnvironmentId: 'env-1' }
        ],
        'repo-b': [
          { id: 'wt-1', repoId: 'repo-b', hostId: null, runtimeOwnerEnvironmentId: 'env-2' }
        ]
      }
    } as unknown as WorktreeRuntimeOwnerState
    // Escolher um dono no palpite abriria o segundo writer que este caminho existe para evitar.
    expect(() => runtimeTargetForWorktreeOwner(ambiguous, 'wt-1')).toThrow(
      AmbiguousStructuredSessionOwnerError
    )
  })

  it('stays local for a worktree no environment owns', () => {
    expect(runtimeTargetForWorktreeOwner(stateWithOwner(undefined, undefined), 'wt-1')).toEqual({
      kind: 'local'
    })
  })
})

describe('the probe and the create land in the worktree owner environment', () => {
  it('sends createSupport and create to the same env that owns the workspace', async () => {
    const { createStructuredAgentSessionLaunchIntent, launchStructuredAgentSession } =
      await import('./launch-structured-agent-session')
    // Foco global em env-2; a workspace pertence a env-1.
    mocks.state = stateWithOwner('env-1', 'env-2') as unknown as Record<string, unknown>
    mocks.call.mockReset()
    mocks.call
      .mockResolvedValueOnce({ supported: true })
      .mockResolvedValueOnce({ ok: true, value: { sessionId: 'codex-session-1', fence: 1 } })

    const intent = createStructuredAgentSessionLaunchIntent('wt-1', 'codex')
    expect(intent.target).toEqual({ kind: 'environment', environmentId: 'env-1' })

    await launchStructuredAgentSession(intent)

    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.call.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(mocks.call.mock.calls[0]?.[1]).toBe('agentSession.createSupport')
    expect(mocks.call.mock.calls[1]?.[0]).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(mocks.call.mock.calls[1]?.[1]).toBe('agentSession.create')
  })
})
