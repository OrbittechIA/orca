import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import type { ForceReconnect, RpcClientContextValue } from './rpc-client-context-contract'
import { BRIDGE_PAGE_CLIENT_ID } from '../mobile-web-shell/bridge/bridge-page-client-identity'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { useRpcClientContext as useSharedRpcClientContext } from './rpc-client-context'

import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import { RpcClientProvider, useRpcClientContext, usePageBridgeClient } from './client-context.web'
import { useForceReconnect, useHostClient } from './host-client-hooks'

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'reconnecting',
    reconnectAttempt: 4,
    lastConnectedAt: 1700,
    lastInboundAt: 1800,
    generation: 5
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('useForceReconnect on the page', () => {
  it('answers null through the real hook, which is what every Retry reads', () => {
    const channel: {
      postMessage: (json: string) => void
      onmessage: ((e: { data: string }) => void) | null
    } = {
      postMessage: () => {},
      onmessage: null
    }
    Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
    const client = createShellPageClient()
    if (client === null) {
      throw new Error('no channel installed')
    }
    channel.onmessage?.({ data: JSON.stringify(INIT) })
    const read: { value: ForceReconnect | undefined } = { value: undefined }
    function Probe(): null {
      read.value = useForceReconnect()
      return null
    }
    act(() => {
      create(
        <RpcClientProvider client={client}>
          <Probe />
        </RpcClientProvider>
      )
    })
    expect(read.value).toBeNull()
  })

  it('carries the page client and state through real shared hooks without taking ownership', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const close = vi.spyOn(pair.client, 'close')
    const reads: {
      page: RpcClientContextValue | null
      shared: RpcClientContextValue | null
      host: ReturnType<typeof useHostClient> | null
      mounts: number
    } = { page: null, shared: null, host: null, mounts: 0 }
    function Probe(): null {
      reads.page = useRpcClientContext()
      reads.shared = useSharedRpcClientContext()
      reads.host = useHostClient('host-a')
      expect(usePageBridgeClient()).toBe(pair.client)
      expect(useForceReconnect()).toBeNull()
      reads.mounts += 1
      return null
    }
    const mounted: { renderer: ReactTestRenderer | null } = { renderer: null }
    await act(async () => {
      mounted.renderer = create(
        <RpcClientProvider client={pair.client}>
          <Probe />
        </RpcClientProvider>
      )
    })
    const renderer = mounted.renderer
    if (!renderer) {
      throw new Error('page provider did not mount')
    }
    try {
      expect(reads.shared).toBe(reads.page)
      expect(reads.host?.client).toBe(pair.client)
      expect(reads.host?.clientId).toBe(BRIDGE_PAGE_CLIENT_ID)
      expect(reads.host?.state).toBe('connected')
      await act(async () => {
        pair.rpc.pushState('reconnecting')
        await pair.flush()
      })
      expect(reads.host?.state).toBe('reconnecting')
      await act(async () => renderer.unmount())
      const mounts = reads.mounts
      pair.rpc.pushState('connected')
      await pair.flush()
      expect(reads.mounts).toBe(mounts)
      expect(pair.client.getState()).toBe('connected')
      expect(close).not.toHaveBeenCalled()
    } finally {
      await act(async () => renderer.unmount())
      pair.client.close()
      pair.host.dispose()
    }
  })
})
