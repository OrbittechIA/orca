import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RuntimeWorktreePsResult } from '../../../../shared/runtime-types'
import type { RpcContext } from '../core'
import {
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub
} from './structured-agent-session-rpc.test-fixture'
import { scopeWorktreePsStructuredIdentity } from './worktree-ps-structured-identity-scope'

const RECORDS = new Map([
  [
    'start-a',
    {
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-a' }
    }
  ],
  ['ordinary', {}]
])

function row(sessionId: string | undefined) {
  return {
    paneKey: `pane-${sessionId ?? 'terminal'}`,
    ...(sessionId
      ? {
          sessionId,
          providerSession: { key: 'codex', id: `thread-${sessionId}` }
        }
      : {})
  }
}

function result(): RuntimeWorktreePsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope reads only `worktrees[].agents[]` identity fields, all declared here.
  return {
    worktrees: [{ worktreeId: 'wt-1', agents: [row('start-a'), row('ordinary'), row(undefined)] }]
  } as unknown as RuntimeWorktreePsResult
}

function ctx(deviceId: string, capability: string, globalEnabled: boolean): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the structured gate reads only these context members.
  return {
    clientKind: 'runtime',
    clientCapabilities: [capability],
    pairedDeviceId: deviceId,
    runtime: { getClientSettings: () => ({ experimentalStructuredNativeChat: globalEnabled }) }
  } as unknown as RpcContext
}

function identities(scoped: RuntimeWorktreePsResult) {
  return scoped.worktrees[0]?.agents.map((agent) => [
    agent.paneKey,
    agent.sessionId,
    agent.providerSession?.id
  ])
}

beforeEach(() => {
  installStructuredHostStub()
  hostCalls.getRecord.mockImplementation((id: string) => RECORDS.get(id) ?? null)
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('worktree.ps structured identity scope', () => {
  it('shows a Start session identity to its owner only', () => {
    const owner = ctx('device-a', WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY, false)
    const other = ctx('device-b', WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY, false)

    expect(identities(scopeWorktreePsStructuredIdentity(result(), owner))).toEqual([
      ['pane-start-a', 'start-a', 'thread-start-a'],
      ['pane-ordinary', undefined, undefined],
      ['pane-terminal', undefined, undefined]
    ])
    expect(identities(scopeWorktreePsStructuredIdentity(result(), other))).toEqual([
      ['pane-start-a', undefined, undefined],
      ['pane-ordinary', undefined, undefined],
      ['pane-terminal', undefined, undefined]
    ])
  })

  it('keeps ordinary identities for a globally admitted caller but not foreign Start ones', () => {
    const global = ctx('device-b', STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, true)
    expect(identities(scopeWorktreePsStructuredIdentity(result(), global))).toEqual([
      ['pane-start-a', undefined, undefined],
      ['pane-ordinary', 'ordinary', 'thread-ordinary'],
      ['pane-terminal', undefined, undefined]
    ])
  })

  it('returns the in-process result untouched', () => {
    const input = result()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: in-process callers carry no client kind.
    expect(scopeWorktreePsStructuredIdentity(input, {} as RpcContext)).toBe(input)
  })
})
