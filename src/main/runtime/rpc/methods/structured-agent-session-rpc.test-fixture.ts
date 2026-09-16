// The `agentSession.*` dispatcher harness, shared by the suites that exercise the wire
// boundary. `hostCalls` and `runtimeCalls` keep one identity for the process and are
// repopulated per test, so a suite can read `hostCalls.close` without re-importing it.

import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import {
  resetStatusFeed,
  statusFeedInstance
} from './structured-agent-session-rpc-status.test-fixture'

export {
  publishStatusItems,
  STATUS_ITEMS,
  STATUS_SESSION,
  statusFeedInstance
} from './structured-agent-session-rpc-status.test-fixture'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

export const SESSION = 'session-alpha'
export const FINGERPRINT = 'f'.repeat(64)
export const OPERATION = '1800000000000-00000000000000000000000000000001'

export function envelope(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    clientOperationId: OPERATION,
    expectedRuntimeFence: 1,
    payloadFingerprint: FINGERPRINT,
    ...overrides
  }
}

export function sendParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope(),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...overrides
  }
}

export function attachParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope({ expectedRuntimeFence: null }),
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    ...overrides
  }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

export const hostCalls: Record<string, ReturnType<typeof vi.fn>> = {}
export const runtimeCalls: Record<string, ReturnType<typeof vi.fn>> = {}

function reset(record: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const key of Object.keys(record)) {
    delete record[key]
  }
}

export function hostStub(): StructuredAgentSessionHost {
  reset(hostCalls)
  resetStatusFeed()
  Object.assign(hostCalls, {
    attach: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      value: {
        sessionId: SESSION,
        fence: 1,
        page: {
          sessionId: SESSION,
          epoch: 'epoch-a',
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [],
          window: {
            oldest: null,
            newest: null,
            nextCursor: { epoch: 'epoch-a', sequence: 0 }
          },
          liveCursor: { epoch: 'epoch-a', sequence: 0 },
          hasOlder: false,
          hasNewer: false
        },
        unconfirmedClientMessageIds: []
      }
    })),
    rewind: vi.fn(async () => ({ ok: true, value: { itemId: 'chosen', epoch: 'next' } })),
    send: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 1 },
      value: {
        clientMessageId: OPERATION,
        submission: {
          clientMessageId: OPERATION,
          fence: 1,
          payloadFingerprint: FINGERPRINT,
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })),
    waitForSendSettlement: vi.fn(),
    cancel: vi.fn(async () => ({ ok: true, replayed: false })),
    close: vi.fn(async () => undefined),
    revealSession: vi.fn(async () => ({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent: 'codex' as const,
      readable: true
    })),
    setSessionTabVisibility: vi.fn(async () => undefined),
    respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
    setOption: vi.fn(async () => ({ ok: true, replayed: false })),
    requestHandoff: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      value: {
        status: {
          owner: 'native',
          direction: null,
          phase: 'idle',
          stage: null,
          operationId: null
        }
      }
    })),
    supportsCreate: vi.fn(() => true),
    handoffStatus: vi.fn(async () => ({ owner: 'native' })),
    readOptions: vi.fn(async () => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live' }
    })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    subscribe: vi.fn(() => () => undefined),
    // A real feed, so the snapshot this method hands back is a genuine projection rather
    // than a shape the stub restated.
    getRecord: vi.fn(() => null),
    listRecords: vi.fn(() => []),
    subscribeStatus: vi.fn(
      (
        subscriber: StructuredAgentSessionStatusSubscriber,
        includeSession?: (sessionId: string) => boolean
      ) => statusFeedInstance().subscribe(subscriber, includeSession)
    ),
    unsubscribe: vi.fn(),
    release: vi.fn()
  })
  // O gate escopado do Work Item Start lê o registro pelo store do host; sem expor
  // `deps.store` a fixture não consegue exercer nem a admissão nem a recusa.
  return {
    ...hostCalls,
    deps: {
      store: {
        getRecord: hostCalls.getRecord,
        listRecords: hostCalls.listRecords
      }
    }
  } as unknown as StructuredAgentSessionHost
}

export function dispatcher(runtimeOverrides: Record<string, unknown> = {}): RpcDispatcher {
  reset(runtimeCalls)
  Object.assign(runtimeCalls, {
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (params) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: params.agent,
      agent: params.agent,
      accountHome: {
        variable: params.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: params.agent === 'claude' ? '/host/.claude' : '/host/.codex'
      },
      options:
        params.agent === 'claude'
          ? { model: 'opus', effort: 'high' }
          : { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    publishStructuredAgentSessionTab: vi.fn()
  })
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn(),
    ...runtimeCalls,
    ...runtimeOverrides
  }
  return new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: STRUCTURED_AGENT_SESSION_METHODS
  })
}

/** The reply path is the only one that carries a client's negotiated identity,
 *  which is exactly what the capability gate reads. */
type FixtureClient = {
  clientId?: string
  /** Streams are keyed per connection; two clients on one test need two of these. */
  connectionId?: string
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: string[]
  // O gate do Work Item Start decide por estes dois; sem eles a fixture não consegue
  // exercer nem a autoridade local nem a de device pareado.
  localDesktopAuthority?: true
  pairedDeviceId?: string
  signal?: AbortSignal
}

/** Like `call`, but keeps the live reply list: a streaming method keeps writing to it after
 *  the dispatch resolves, which is what a subscription boundary test has to observe. */
export async function callStreaming(
  method: string,
  params: unknown,
  client?: FixtureClient,
  runtimeOverrides: Record<string, unknown> = {}
): Promise<{ first: RpcResponse; replies: RpcResponse[] }> {
  const replies: RpcResponse[] = []
  await dispatcher(runtimeOverrides).dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  const first = replies[0]
  if (!first) {
    throw new Error(`no reply for ${method}`)
  }
  return { first, replies }
}

export async function call(
  method: string,
  params: unknown,
  client?: FixtureClient,
  runtimeOverrides: Record<string, unknown> = {}
): Promise<RpcResponse> {
  return (await callStreaming(method, params, client, runtimeOverrides)).first
}

export const STRUCTURED_CLIENT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}
export const STRUCTURED_MOBILE_CLIENT = {
  clientKind: 'mobile' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
  ]
}

/** Every suite wants the same lifecycle: a fresh stub per test, no host left installed. */
export function installStructuredHostStub(): void {
  setStructuredAgentSessionHost(hostStub())
}

export function clearStructuredHostStub(): void {
  setStructuredAgentSessionHost(null)
}
