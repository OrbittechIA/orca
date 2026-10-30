import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAttentionOrigin } from '../../../../shared/agent-session-attention'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { RuntimeMobileNotificationController } from '../../runtime-mobile-notification-controller'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  call,
  clearStructuredHostStub,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

let directory: string
let hostController: RuntimeMobileNotificationController | undefined
beforeEach(() => {
  installStructuredHostStub()
  directory = mkdtempSync(join(tmpdir(), 'orca-attention-ack-'))
})
afterEach(async () => {
  clearStructuredHostStub()
  await hostController?.closeDismissals()
  hostController = undefined
  rmSync(directory, { recursive: true, force: true })
})

type HostId = StructuredAttentionOrigin['scope']['executionHostId']
const scope = (executionHostId: HostId): StructuredAttentionOrigin['scope'] => ({
  executionHostId,
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
})

/** This host's store holding deliveries for several sessions, scopes and journal positions. */
function hostWithDeliveries() {
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  hostController = controller
  const dismissed: string[] = []
  controller.onDispatched((event) => {
    if (event.type === 'dismiss') {
      dismissed.push(event.notificationId)
    }
  })
  const deliver = (id: string, origin: StructuredAttentionOrigin) =>
    controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: id,
      body: '',
      notificationId: id,
      structuredOrigin: origin
    })
  const prompt = (sessionId: string, epoch: string, sequence: number, host: HostId = 'local') => ({
    scope: scope(host),
    sessionId,
    cause: { kind: 'prompt' as const, promptId: `${sessionId}-${sequence}` },
    journalCursor: { epoch, sequence }
  })
  deliver('read', prompt(SESSION, 'journal-a', 5))
  deliver('newer', prompt(SESSION, 'journal-a', 20))
  deliver('other-session', prompt('session-2', 'journal-b', 5))
  // Another scope's journal for the same session id mints its own epoch.
  deliver('other-scope', prompt(SESSION, 'journal-c', 5, 'runtime:remote'))
  return { controller, dismissed }
}

/** The durable record store alone, as the runtime opens it without building a provider host. */
function recordStoreHolding(record: AgentSessionRecord | null) {
  return vi.fn(async () => ({
    getRecord: (sessionId: string) => (sessionId === record?.sessionId ? record : null)
  }))
}

describe('agentSession.acknowledgeAttention', () => {
  it('retires the deliveries the read covers without installing a host', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const { controller, dismissed } = hostWithDeliveries()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      {
        retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
        ensureStructuredAgentSessionHost: install,
        openAgentSessionRecordStore: recordStoreHolding(
          agentSessionRecordFixture({ sessionId: SESSION, provider: 'codex' })
        )
      }
    )
    expect(reply).toMatchObject({ ok: true, result: { acknowledged: true } })
    expect(install).not.toHaveBeenCalled()
    // A newer prompt, another session and another scope's journal all stay live.
    expect(dismissed).toEqual(['read'])
  })

  const unprovable: { label: string; record: AgentSessionRecord | null }[] = [
    { label: 'a session with no record', record: null },
    {
      label: "another device's Work Item Start chat",
      record: agentSessionRecordFixture({
        sessionId: SESSION,
        provider: 'codex',
        launchOrigin: 'work-item-start',
        launchAuthority: { kind: 'paired-device', deviceId: 'another-device' }
      })
    }
  ]
  it.each(unprovable)(
    'retires nothing for $label without installing a host',
    async ({ record }) => {
      setStructuredAgentSessionHost(null)
      const install = vi.fn()
      const { controller, dismissed } = hostWithDeliveries()
      const reply = await call(
        'agentSession.acknowledgeAttention',
        { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
        STRUCTURED_CLIENT,
        {
          retireStructuredAttention: controller.retireStructuredAttention.bind(controller),
          ensureStructuredAgentSessionHost: install,
          openAgentSessionRecordStore: recordStoreHolding(record)
        }
      )
      expect(reply).toMatchObject({ ok: false })
      expect(install).not.toHaveBeenCalled()
      expect(dismissed).toEqual([])
    }
  )

  it('retires nothing when the record store cannot be opened', async () => {
    setStructuredAgentSessionHost(null)
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      STRUCTURED_CLIENT,
      {
        retireStructuredAttention: retire,
        ensureStructuredAgentSessionHost: vi.fn(),
        openAgentSessionRecordStore: vi.fn(async () => {
          throw new Error('journal unavailable')
        })
      }
    )
    expect(reply).toMatchObject({ ok: false })
    expect(retire).not.toHaveBeenCalled()
  })

  it('refuses a read without its journal boundary or with unknown fields, before any work', async () => {
    const retire = vi.fn()
    for (const params of [
      { sessionId: SESSION },
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 }, extra: true }
    ]) {
      const reply = await call('agentSession.acknowledgeAttention', params, STRUCTURED_CLIENT, {
        retireStructuredAttention: retire
      })
      expect(reply).toMatchObject({ ok: false })
    }
    expect(retire).not.toHaveBeenCalled()
  })

  it('rejects a caller without structured capability before any work', async () => {
    setStructuredAgentSessionHost(null)
    const install = vi.fn()
    const retire = vi.fn()
    const reply = await call(
      'agentSession.acknowledgeAttention',
      { sessionId: SESSION, observedCursor: { epoch: 'journal-a', sequence: 10 } },
      { clientKind: 'runtime', clientCapabilities: [] },
      { retireStructuredAttention: retire, ensureStructuredAgentSessionHost: install }
    )
    expect(reply).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('structured_agent_session_unsupported') }
    })
    expect(install).not.toHaveBeenCalled()
    expect(retire).not.toHaveBeenCalled()
  })
})
