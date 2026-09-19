import { isUnknownRecord } from '../../../../shared/unknown-record'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { projectSessionTabsForContext } from './session-tabs-inventory'
import {
  structuredAgentSessionCreateWorktreeTarget,
  structuredAgentSessionCreateWorktreeTargetsEqual
} from '../../structured-agent-session-create-worktree-target'
import {
  call,
  callStreaming,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  publishStatusItems,
  SESSION,
  STATUS_ITEMS,
  STATUS_SESSION,
  statusFeedInstance,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const FIELDS = {
  worktree: 'id:workspace-1',
  agent: 'codex' as const,
  launchOrigin: 'work-item-start' as const
}

/** The create target the runtime resolves, folder-aware — not `showManagedWorktree`. */
function createTarget(
  creatorProvenance: { kind: 'host' } | { kind: 'paired-device'; deviceId: string },
  worktreeId = 'workspace-1'
) {
  return structuredAgentSessionCreateWorktreeTarget({
    id: worktreeId,
    path: `/workspaces/${worktreeId}`,
    creatorProvenance
  })
}

const SETTINGS = {
  getClientSettings: () => ({
    experimentalStructuredNativeChat: false,
    workItemStartPromptDelivery: 'submit-after-ready'
  })
}

const ENABLED_SETTINGS = {
  getClientSettings: () => ({
    experimentalStructuredNativeChat: true,
    workItemStartPromptDelivery: 'submit-after-ready'
  })
}

function createParams() {
  return {
    envelope: envelope({
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION,
        fields: FIELDS
      })
    }),
    ...FIELDS
  }
}

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('Web Work Item Start authority', () => {
  it('derives launch authority from the paired runtime that created the worktree', async () => {
    const client = {
      ...STRUCTURED_CLIENT,
      clientId: 'device-token',
      pairedDeviceId: 'device-web'
    }
    const runtime = {
      ...SETTINGS,
      resolveStructuredAgentSessionCreateWorktreeTarget: async () =>
        createTarget({ kind: 'paired-device', deviceId: 'device-web' })
    }

    await expect(
      call('agentSession.createSupport', FIELDS, client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { supported: true } })
    await expect(
      call('agentSession.create', createParams(), client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: 'device-web' }
      })
    )

    await expect(
      call(
        'agentSession.createSupport',
        FIELDS,
        { ...client, pairedDeviceId: 'device-other' },
        runtime
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('hands the admitted worktree target to the resolver and refuses a replaced checkout', async () => {
    const client = { ...STRUCTURED_CLIENT, clientId: 'device-token', pairedDeviceId: 'device-web' }
    const admitted = createTarget({ kind: 'paired-device', deviceId: 'device-web' })
    // The resolver compares the admitted target against the worktree RECORD it resolves now.
    // Between admission and create the same id on the same host can be re-created at another
    // path, by another instance, or by another device; only the full comparison catches that.
    const current = { value: admitted }
    const resolveIntent = vi.fn(async (params: { expectedWorktreeTarget?: typeof admitted }) => {
      if (
        params.expectedWorktreeTarget &&
        !structuredAgentSessionCreateWorktreeTargetsEqual(
          params.expectedWorktreeTarget,
          current.value
        )
      ) {
        throw new Error('structured_agent_session_unsupported')
      }
      return {
        envelope: { sessionId: SESSION, clientOperationId: 'op' },
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'workspace-1',
          workspaceKind: 'git-worktree'
        },
        provider: 'codex',
        agent: 'codex',
        runtimeKind: 'native',
        accountHome: { variable: 'CODEX_HOME', path: '/home/codex' },
        journalRoot: '/journals'
      }
    })
    const runtime = {
      ...SETTINGS,
      resolveStructuredAgentSessionCreateWorktreeTarget: async () => admitted,
      resolveStructuredAgentSessionCreateIntent: resolveIntent
    }

    await expect(
      call('agentSession.create', createParams(), client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(resolveIntent).toHaveBeenCalledWith(
      expect.objectContaining({ expectedWorktreeTarget: admitted })
    )
    hostCalls.attach.mockClear()

    for (const replaced of [
      { ...admitted, workspacePath: '/workspaces/workspace-1-recreated' },
      { ...admitted, instanceId: 'instance-2' },
      { ...admitted, creatorKind: 'paired-device' as const, creatorDeviceId: 'device-other' }
    ]) {
      current.value = replaced
      const response = await call('agentSession.create', createParams(), client, runtime)
      expect(response).toMatchObject({
        ok: true,
        result: { ok: false, refusal: { code: 'structured_agent_session_unsupported' } }
      })
    }
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it('admits a folder workspace, which the managed-worktree resolver cannot name', async () => {
    // The regression this pins: the scoped admission used to resolve through
    // `showManagedWorktree`, whose candidate set is repo-derived worktrees only. A folder
    // workspace selector came back `selector_not_found`, the client retried three times and
    // then treated it as definitive — and because the strict route had already dropped the
    // terminal startup, the folder workspace was left with no agent and no terminal. Folder
    // workspaces carry their own `creatorProvenance`, so nothing about the paired-device
    // check has to be relaxed to reach them.
    const client = { ...STRUCTURED_CLIENT, clientId: 'device-token', pairedDeviceId: 'device-web' }
    const runtime = {
      ...SETTINGS,
      resolveStructuredAgentSessionCreateWorktreeTarget: vi.fn(async () =>
        createTarget({ kind: 'paired-device', deviceId: 'device-web' }, 'folder:abc')
      )
    }

    await expect(
      call('agentSession.createSupport', { ...FIELDS, worktree: 'id:folder:abc' }, client, runtime)
    ).resolves.toMatchObject({ ok: true, result: { supported: true } })
    expect(runtime.resolveStructuredAgentSessionCreateWorktreeTarget).toHaveBeenCalledWith(
      'id:folder:abc'
    )

    // And a folder workspace created by a different device is still refused.
    await expect(
      call(
        'agentSession.createSupport',
        { ...FIELDS, worktree: 'id:folder:abc' },
        { ...client, pairedDeviceId: 'device-other' },
        runtime
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
  })

  it('fails closed before adoption when the durable session or selector is not authoritative', async () => {
    const client = { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-other' }
    hostCalls.getRecord.mockReturnValue({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
    })
    const showManagedWorktree = vi.fn(async () =>
      createTarget({ kind: 'paired-device', deviceId: 'device-other' })
    )

    for (const [method, input] of [
      ['agentSession.createSupport', { ...FIELDS, sessionId: SESSION }],
      ['agentSession.create', createParams()]
    ] as const) {
      await expect(
        call(method, input, client, {
          ...SETTINGS,
          resolveStructuredAgentSessionCreateWorktreeTarget: showManagedWorktree
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
    }
    expect(showManagedWorktree).not.toHaveBeenCalled()
    expect(hostCalls.attach).not.toHaveBeenCalled()

    hostCalls.getRecord.mockReturnValue(null)
    showManagedWorktree.mockRejectedValue(new Error('selector_ambiguous'))
    await expect(
      call('agentSession.createSupport', FIELDS, client, {
        ...SETTINGS,
        resolveStructuredAgentSessionCreateWorktreeTarget: showManagedWorktree
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('selector_ambiguous') }
    })
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it('refuses a selector that changes after provenance authorization', async () => {
    const client = { ...STRUCTURED_CLIENT, pairedDeviceId: 'device-owner' }
    const showManagedWorktree = vi.fn(async () =>
      createTarget({ kind: 'paired-device', deviceId: 'device-owner' })
    )
    const resolveStructuredAgentSessionCreateIntent = vi.fn(async (params) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'workspace-2',
        workspaceKind: 'git-worktree' as const
      },
      provider: params.agent,
      agent: params.agent,
      accountHome: { variable: 'CODEX_HOME' as const, path: '/host/.codex' },
      runtimeKind: 'native' as const
    }))

    await expect(
      call('agentSession.create', createParams(), client, {
        ...ENABLED_SETTINGS,
        resolveStructuredAgentSessionCreateWorktreeTarget: showManagedWorktree,
        resolveStructuredAgentSessionCreateIntent
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported' }
      }
    })
    expect(showManagedWorktree).toHaveBeenCalledOnce()
    expect(resolveStructuredAgentSessionCreateIntent).toHaveBeenCalledOnce()
    expect(hostCalls.attach).not.toHaveBeenCalled()
  })

  it.each([
    ['paired runtime', STRUCTURED_CLIENT],
    ['mobile', STRUCTURED_MOBILE_CLIENT]
  ] as const)(
    'keeps scoped history, status, and tabs private with global chat enabled for %s',
    async (_name, clientKind) => {
      hostCalls.getRecord.mockImplementation((sessionId) =>
        sessionId === SESSION || sessionId === STATUS_SESSION
          ? {
              launchOrigin: 'work-item-start',
              launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
            }
          : { launchOrigin: undefined }
      )
      hostCalls.listRecords.mockReturnValue([
        { sessionId: SESSION, launchOrigin: 'work-item-start' }
      ])
      const other = { ...clientKind, pairedDeviceId: 'device-other' }
      const owner = { ...clientKind, pairedDeviceId: 'device-owner' }

      await expect(
        call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, other, {
          ...ENABLED_SETTINGS
        })
      ).resolves.toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      if (clientKind.clientKind === 'runtime') {
        await expect(
          call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, owner, {
            ...ENABLED_SETTINGS
          })
        ).resolves.toMatchObject({ ok: true })
      }
      await expect(
        call('agentSession.history', { sessionId: 'ordinary', direction: 'tail' }, other, {
          ...ENABLED_SETTINGS
        })
      ).resolves.toMatchObject({ ok: true })

      const hiddenStatus = await call('agentSession.subscribeStatus', null, other, {
        ...ENABLED_SETTINGS
      })
      expect(hiddenStatus).toMatchObject({
        ok: true,
        result: { type: 'snapshot', sessions: [] }
      })

      const snapshot = {
        worktree: 'workspace-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            id: `agent-session:${SESSION}`,
            type: 'agent-session' as const,
            sessionId: SESSION,
            agent: 'codex' as const,
            title: 'Codex',
            isActive: false
          },
          {
            id: 'agent-session:ordinary',
            type: 'agent-session' as const,
            sessionId: 'ordinary',
            agent: 'codex' as const,
            title: 'Ordinary',
            isActive: false
          }
        ]
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab projection reads `getClientSettings` off the runtime only.
      const context = { runtime: ENABLED_SETTINGS as never, ...other }
      expect(projectSessionTabsForContext(snapshot, context).tabs.map((tab) => tab.id)).toEqual([
        'agent-session:ordinary'
      ])
    }
  )

  it.each([
    ['paired runtime', STRUCTURED_CLIENT],
    ['mobile', STRUCTURED_MOBILE_CLIENT]
  ] as const)(
    'keeps later status and revoke events of a scoped session away from %s that cannot access it',
    async (_name, clientKind) => {
      hostCalls.getRecord.mockImplementation((sessionId) =>
        sessionId === STATUS_SESSION
          ? {
              launchOrigin: 'work-item-start',
              launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
            }
          : { launchOrigin: undefined }
      )
      // Two connections: the status stream is keyed per connection, and one id would let the
      // second subscribe evict the first instead of proving anything about scope.
      const other = { ...clientKind, pairedDeviceId: 'device-other', connectionId: 'conn-other' }
      const owner = {
        ...STRUCTURED_CLIENT,
        pairedDeviceId: 'device-owner',
        connectionId: 'conn-owner'
      }

      const denied = await callStreaming('agentSession.subscribeStatus', null, other, {
        ...ENABLED_SETTINGS
      })
      const admitted = await callStreaming('agentSession.subscribeStatus', null, owner, {
        ...ENABLED_SETTINGS
      })
      expect(denied.first).toMatchObject({ ok: true, result: { type: 'snapshot', sessions: [] } })
      expect(admitted.first).toMatchObject({
        ok: true,
        result: {
          type: 'snapshot',
          sessions: [expect.objectContaining({ sessionId: STATUS_SESSION })]
        }
      })

      // The leak was here: the snapshot was filtered, but a later publish or an ownership
      // revoke named its session at `event.session` and bypassed the subscriber's scope.
      publishStatusItems([
        ...STATUS_ITEMS,
        {
          itemId: 'user-2',
          sequence: 3,
          revision: 1,
          observedAt: 3,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'scoped follow-up prompt' }]
          }
        }
      ])
      statusFeedInstance().revokeLive(STATUS_SESSION)

      const statusEvents = (replies: typeof denied.replies) =>
        replies.filter(
          (reply) => reply.ok && isUnknownRecord(reply.result) && reply.result.type === 'status'
        )
      expect(statusEvents(denied.replies)).toEqual([])
      expect(JSON.stringify(denied.replies)).not.toContain('scoped follow-up prompt')
      expect(statusEvents(admitted.replies)).toHaveLength(2)
      expect(JSON.stringify(admitted.replies)).toContain('scoped follow-up prompt')
    }
  )

  it('projects a Draft session only to its creating paired runtime', () => {
    hostCalls.getRecord.mockReturnValue({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' }
    })
    const snapshot = {
      worktree: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: `agent-session:${SESSION}`,
      activeTabType: 'agent-session' as const,
      tabs: [
        {
          id: `agent-session:${SESSION}`,
          type: 'agent-session' as const,
          sessionId: SESSION,
          agent: 'codex' as const,
          title: 'Codex',
          isActive: true
        }
      ]
    }
    const context = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab projection reads `getClientSettings` off the runtime only.
      runtime: SETTINGS as never,
      clientKind: 'runtime' as const,
      clientCapabilities: STRUCTURED_CLIENT.clientCapabilities
    }

    expect(
      projectSessionTabsForContext(snapshot, { ...context, pairedDeviceId: 'device-owner' }).tabs
    ).toHaveLength(1)
    expect(
      projectSessionTabsForContext(snapshot, { ...context, pairedDeviceId: 'device-other' }).tabs
    ).toEqual([])
  })
})
