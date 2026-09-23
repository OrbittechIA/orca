import { isUnknownRecord } from '../../../shared/unknown-record'
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
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

  it('declares Start-scoped structured reach, never the generic structured capability', async () => {
    // Paired web Work Item Start needs `agentSession.*` for its own sessions only. The generic
    // capability would also open every ordinary structured chat on the host, so it stays absent.
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

    const frame: unknown = sendEncrypted.mock.calls[0]?.[0]
    const capabilities = isUnknownRecord(frame) ? frame.clientCapabilities : undefined
    expect(capabilities).toContain(WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY)
    expect(capabilities).toContain(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    for (const generic of [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
    ]) {
      expect(capabilities).not.toContain(generic)
    }
  })
})
