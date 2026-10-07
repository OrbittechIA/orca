import { describe, expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'
import { computeAgentSessionPayloadFingerprint } from './agent-session-mutation-envelope'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from './electron-remote-runtime-client-capabilities'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
} from './protocol-version'
import { CreateIntentParams } from './rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateParams } from './structured-agent-session-create'
import { resolveStructuredNativeChatSupport } from './structured-native-chat-launch-route'

const input = {
  sessionId: 'codex_11111111_2222_3333_4444_555555555555',
  worktree: 'id:repo-1::/repo/orca',
  agent: 'codex' as const,
  tabId: 'tab-1',
  randomUuid: () => '00000000-0000-4000-8000-000000000001',
  now: 1_800_000_000_000
}

describe('Work Item Start with current structured session contracts', () => {
  it('validates and fingerprints the scoped origin together with the reserved tab', () => {
    const params = structuredAgentSessionCreateParams({
      ...input,
      launchOrigin: 'work-item-start'
    })
    expect(CreateIntentParams.parse(params)).toEqual(params)
    expect(params.envelope.payloadFingerprint).toBe(
      computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: input.sessionId,
        fields: {
          worktree: input.worktree,
          agent: input.agent,
          tabId: input.tabId,
          launchOrigin: 'work-item-start'
        }
      })
    )
    expect(params.envelope.payloadFingerprint).not.toBe(
      structuredAgentSessionCreateParams(input).envelope.payloadFingerprint
    )
    expect(CreateIntentParams.safeParse({ ...params, launchOrigin: 'unscoped' }).success).toBe(
      false
    )
  })

  it('retains authority in a durable scoped record and refuses authority without its origin', () => {
    const record = agentSessionRecordFixture()
    const launchAuthority = { kind: 'paired-device', deviceId: 'paired-1' }
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        launchOrigin: 'work-item-start',
        launchAuthority
      })
    ).toBe(true)
    expect(isPersistedAgentSessionRecord({ ...record, launchAuthority })).toBe(false)
    expect(
      isPersistedAgentSessionRecord({
        ...record,
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: '' }
      })
    ).toBe(false)
  })

  it('adds scoped desktop admission while preserving current structured launch capabilities', () => {
    expect(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toEqual(
      expect.arrayContaining([
        WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
      ])
    )
  })

  it('requires scoped host support in addition to the paired launch contract', () => {
    const route = {
      agent: 'codex' as const,
      executionHostId: 'runtime:paired-1',
      workspaceKind: 'git-worktree' as const,
      launchOrigin: 'work-item-start' as const,
      clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      hostCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
      ]
    }
    expect(resolveStructuredNativeChatSupport(route)).toEqual({
      supported: false,
      blocker: 'runtime-capability'
    })
    expect(
      resolveStructuredNativeChatSupport({
        ...route,
        hostCapabilities: [
          ...route.hostCapabilities,
          WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
        ]
      })
    ).toEqual({ supported: true })
  })
})
