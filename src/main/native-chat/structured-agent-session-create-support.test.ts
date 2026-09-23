import { describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { ClaudeManagedAccountGateSettings } from './claude-structured-managed-account-support'
import type { Repo } from '../../shared/repo-types'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import {
  resolveStructuredAgentSessionCreateSupport,
  workItemStartPreCreateLocation
} from './structured-agent-session-create-support'

const LOCAL: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

function managedAccount(id: string, managedAuthRuntime: 'host' | 'wsl') {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/managed/${id}`,
    managedAuthRuntime,
    authMethod: 'subscription-oauth' as const,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const HOST_SELECTED: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('host-1', 'host')],
  activeClaudeManagedAccountId: 'host-1',
  activeClaudeManagedAccountIdsByRuntime: { host: 'host-1', wsl: {} }
}

const WSL_ONLY: ClaudeManagedAccountGateSettings = {
  claudeManagedAccounts: [managedAccount('wsl-1', 'wsl')],
  activeClaudeManagedAccountId: null,
  activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'wsl-1' } }
}

function support(
  overrides: Partial<Parameters<typeof resolveStructuredAgentSessionCreateSupport>[0]> = {}
) {
  return resolveStructuredAgentSessionCreateSupport({
    agent: 'claude',
    location: LOCAL,
    adapterSupportsCreate: true,
    getSettings: () => HOST_SELECTED,
    ...overrides
  })
}

describe('resolveStructuredAgentSessionCreateSupport', () => {
  it('supports Claude under a selected host account', () => {
    expect(support()).toEqual({ supported: true })
  })

  it('refuses Claude under a WSL-only managed account as an agent refusal, not a WSL workspace', () => {
    expect(support({ getSettings: () => WSL_ONLY })).toEqual({ supported: false, reason: 'agent' })
  })

  it('fails closed for Claude when the settings throw', () => {
    expect(
      support({
        getSettings: () => {
          throw new Error('no store')
        }
      })
    ).toEqual({ supported: false, reason: 'agent' })
  })

  it('leaves Codex to the adapter answer under the same WSL-only account', () => {
    expect(support({ agent: 'codex', getSettings: () => WSL_ONLY })).toEqual({ supported: true })
  })

  it.each([
    ['remote', { ...LOCAL, executionHostId: 'ssh:host-a' }, 'remote'],
    ['wsl workspace', { ...LOCAL, wslDistro: 'Ubuntu' }, 'wsl'],
    ['unsupported agent', LOCAL, 'agent']
  ] as const)('keeps the adapter refusal reason for %s', (_name, location, reason) => {
    expect(support({ adapterSupportsCreate: false, location })).toEqual({
      supported: false,
      reason
    })
  })
})

describe('workItemStartPreCreateLocation', () => {
  const repo = (overrides: Partial<Repo>): Repo => ({
    id: 'repo-1',
    path: '/repos/orca',
    displayName: 'orca',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  })

  function verdict(source: Repo, configuredWslDistro: string | null) {
    const location = workItemStartPreCreateLocation({
      repo: source,
      configuredWslDistro: () => configuredWslDistro
    })
    return resolveStructuredAgentSessionCreateSupport({
      agent: 'codex',
      location,
      adapterSupportsCreate: supportsCodexStructuredLocation(location),
      getSettings: () => HOST_SELECTED
    })
  }

  it('supports a native local repo', () => {
    expect(verdict(repo({}), null)).toEqual({ supported: true })
  })

  it('refuses a native repo under a mismatched managed Claude account as agent, never wsl', () => {
    const location = workItemStartPreCreateLocation({
      repo: repo({ path: 'C:\\src\\orca' }),
      configuredWslDistro: () => null
    })
    expect(location).toMatchObject({ executionHostId: 'local', wslDistro: null })
    expect(
      resolveStructuredAgentSessionCreateSupport({
        agent: 'claude',
        location,
        adapterSupportsCreate: true,
        getSettings: () => WSL_ONLY
      })
    ).toEqual({ supported: false, reason: 'agent' })
  })

  it('refuses a C:\\ repo whose project runtime is WSL', () => {
    expect(verdict(repo({ path: 'C:\\src\\orca' }), 'Ubuntu')).toEqual({
      supported: false,
      reason: 'wsl'
    })
  })

  it('refuses a WSL UNC repo without a configured runtime', () => {
    expect(verdict(repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }), null)).toEqual({
      supported: false,
      reason: 'wsl'
    })
  })

  it('refuses a remote repo without reading the local project runtime', () => {
    const configuredWslDistro = () => {
      throw new Error('local runtime must not be read for a remote repo')
    }
    const location = workItemStartPreCreateLocation({
      repo: repo({ connectionId: 'ssh-1' }),
      configuredWslDistro
    })
    expect(location).toMatchObject({ wslDistro: null })
    expect(
      resolveStructuredAgentSessionCreateSupport({
        agent: 'codex',
        location,
        adapterSupportsCreate: supportsCodexStructuredLocation(location),
        getSettings: () => HOST_SELECTED
      })
    ).toEqual({ supported: false, reason: 'remote' })
  })

  it('keeps folder repos as folder workspaces', () => {
    expect(
      workItemStartPreCreateLocation({
        repo: repo({ kind: 'folder' }),
        configuredWslDistro: () => null
      })
    ).toMatchObject({ workspaceKind: 'folder', executionHostId: 'local' })
  })
})
