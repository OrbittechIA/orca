import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { structuredAgentSessionCreateWorktreeTarget } from './structured-agent-session-create-worktree-target'

type RuntimeInternals = {
  resolveRuntimeFileTarget: (selector: string) => Promise<{
    executionHostId: string
    worktree: {
      id: string
      repoId: string
      path: string
      instanceId?: string
      creatorProvenance?: { kind: string; deviceId: string }
    }
  }>
}

/** A runtime over the store fields this suite reads; nothing else is touched. */
function runtimeOver(
  store: object,
  deps?: ConstructorParameters<typeof OrcaRuntimeService>[2]
): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create-intent path reads only getRepo/getSettings off the store; the fixture pins those.
  return new OrcaRuntimeService(store as never, undefined, deps)
}

/** The protected resolver this suite stubs; the runtime's own type keeps it private. */
function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite replaces `resolveRuntimeFileTarget` with a fixture answering the fields the resolver reads.
  return runtime as unknown as RuntimeInternals
}

/** Only the Claude config-dir lookup is exercised here; the other services are never called. */
function accountServicesWith(claudeAccounts: {
  getRuntimeConfigDir: () => string
}): Parameters<OrcaRuntimeService['setAccountServices']>[0] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads `claudeAccounts.getRuntimeConfigDir` only; codex accounts and rate limits are untouched by this path.
  return { claudeAccounts, codexAccounts: {}, rateLimits: {} } as never
}

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = runtimeOver(
      {
        // The real store always answers this; leaving it out only worked while the call
        // site was optional, which is exactly the masking this test should not do.
        getRepo: () => undefined,
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      },
      { prepareCodexStructuredLaunch }
    )
    const internal = internalsOf(runtime)
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', fastMode: 'true' })
    expect(internal.resolveRuntimeFileTarget).toHaveBeenCalledOnce()
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = runtimeOver(
      {
        // The real store always answers this; leaving it out only worked while the call
        // site was optional, which is exactly the masking this test should not do.
        getRepo: () => undefined,
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      },
      { prepareCodexStructuredLaunch }
    )
    const internal = internalsOf(runtime)
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({ model: 'opus', effort: 'high', fastMode: 'true' })
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = runtimeOver(
      {
        // The real store always answers this; leaving it out only worked while the call
        // site was optional, which is exactly the masking this test should not do.
        getRepo: () => undefined,
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      },
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices(accountServicesWith({ getRuntimeConfigDir }))
    const internal = internalsOf(runtime)
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: { id: 'workspace-1', repoId: 'repo-1', path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })

  it('rejects a resolved checkout that differs from the authorized occupant', async () => {
    const runtime = runtimeOver({ getSettings: () => ({}) })
    const internal = internalsOf(runtime)
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      executionHostId: 'local',
      worktree: {
        id: 'workspace-2',
        repoId: 'repo-1',
        path: '/repos/workspace-2',
        instanceId: 'instance-2',
        creatorProvenance: { kind: 'paired-device', deviceId: 'device-other' }
      }
    }))
    const expectedWorktreeTarget = structuredAgentSessionCreateWorktreeTarget({
      id: 'workspace-1',
      path: '/repos/workspace-1',
      instanceId: 'instance-1',
      creatorProvenance: { kind: 'paired-device', deviceId: 'device-owner' }
    })

    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
        worktree: 'name:changing-alias',
        agent: 'codex',
        expectedWorktreeTarget
      })
    ).rejects.toThrow('structured_agent_session_unsupported')
    expect(internal.resolveRuntimeFileTarget).toHaveBeenCalledOnce()
  })
})
