import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionReserveRequest } from './agent-session/ownership/agent-session-reservation-admission'

export const NOW = 1_800_000_000_000

export const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
export const WSL: AgentSessionExecutionLocation = { ...NATIVE, wslDistro: 'Ubuntu-22.04' }
export const SSH: AgentSessionExecutionLocation = { ...NATIVE, executionHostId: 'ssh:build-box' }
export const FOLDER: AgentSessionExecutionLocation = {
  ...NATIVE,
  workspaceId: 'workspace-2',
  workspaceKind: 'folder'
}

export const MATCHED: AgentSessionOwnerProbe = {
  outcome: 'identity-matched',
  matchedOn: ['spawn-token']
}
export const INDETERMINATE: AgentSessionOwnerProbe = {
  outcome: 'indeterminate',
  reason: 'no answer'
}
export const UNUSED: AgentSessionOwnerProbe = { outcome: 'reservation-unused' }

let counter = 0

export function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

export function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

export function processIdentity(
  overrides: Partial<AgentSessionProcessIdentity> = {}
): AgentSessionProcessIdentity {
  return {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: 1_700_000_000_000,
    spawnToken: 'spawn-a',
    ...overrides
  }
}

export function handleLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: claudeProviderHandle('provider-session-1', 'leaf-1'),
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}
