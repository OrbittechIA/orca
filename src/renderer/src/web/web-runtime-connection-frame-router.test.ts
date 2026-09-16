import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { routeWebRuntimeConnectionFrame } from './web-runtime-connection-frame-router'

describe('web runtime connection capability advertisement', () => {
  it('advertises GitHub PR suppression during E2EE authentication', async () => {
    const sendEncrypted = vi.fn(() => true)

    await routeWebRuntimeConnectionFrame(JSON.stringify({ type: 'e2ee_ready' }), undefined, {
      getState: () => 'handshaking',
      getSharedKey: () => new Uint8Array([1]),
      getSocket: () => null,
      pairingToken: 'token',
      pending: new Map(),
      subscriptions: new Map(),
      sendEncrypted,
      setConnected: vi.fn(),
      setAuthFailed: vi.fn(),
      rejectUnauthorized: vi.fn(),
      notifyUnauthorized: vi.fn()
    })

    expect(sendEncrypted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'e2ee_auth',
        clientCapabilities: expect.arrayContaining([
          WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY
        ])
      })
    )
  })

  it('declares the structured agent session it can actually hold', async () => {
    // This client mounts the full renderer, so it runs structured native chat — but
    // `requireStructuredCapability` refuses every `agentSession.*` call from a `runtime`-scoped
    // client that has not said so here. Without these two entries a paired web Work Item Start is
    // refusable by construction, and the workspace ends up with a pane carrying no session
    // identity, or with no writer at all once the terminal fallback is gone.
    const sendEncrypted = vi.fn((_frame: unknown) => true)

    await routeWebRuntimeConnectionFrame(JSON.stringify({ type: 'e2ee_ready' }), undefined, {
      getState: () => 'handshaking',
      getSharedKey: () => new Uint8Array([1]),
      getSocket: () => null,
      pairingToken: 'token',
      pending: new Map(),
      subscriptions: new Map(),
      sendEncrypted,
      setConnected: vi.fn(),
      setAuthFailed: vi.fn(),
      rejectUnauthorized: vi.fn(),
      notifyUnauthorized: vi.fn()
    })

    const frame = sendEncrypted.mock.calls[0]?.[0] as { clientCapabilities: string[] }
    expect(frame.clientCapabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(frame.clientCapabilities).toContain(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  })
})
