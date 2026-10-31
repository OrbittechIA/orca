import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { createFixedKeyLegacyHandshakeForTest } from '../../../shared/paired-e2ee-fixed-key-test-fixture'
import { decrypt, encrypt } from '../../../shared/e2ee-crypto'
import { WebRuntimeClient } from './web-runtime-client'

const sockets: Socket[] = []
const sharedKey = new Uint8Array(32)
class Socket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = Socket.OPEN
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  send = vi.fn<(frame: string) => void>()
  close = vi.fn()
  constructor(readonly url: string) {
    sockets.push(this)
  }
}
class ConnectedClient extends WebRuntimeClient {
  establish(): void {
    this.handshake = createFixedKeyLegacyHandshakeForTest(sharedKey)
    this.setState('connected')
  }
  deliver(value: unknown): Promise<void> {
    return this.handleSocketMessage(encrypt(JSON.stringify(value), sharedKey))
  }
}
function sent(socket: Socket, index: number) {
  const plaintext = decrypt(socket.send.mock.calls[index][0], sharedKey)
  if (!plaintext) {
    throw new Error('fixture frame missing')
  }
  return JSON.parse(plaintext)
}
const result = (id: string, value: unknown) => ({
  id,
  ok: true,
  result: value,
  _meta: { runtimeId: 'fixture-runtime' }
})
let client: ConnectedClient
beforeEach(() => {
  sockets.length = 0
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  vi.stubGlobal('WebSocket', Socket)
  client = new ConnectedClient(
    pairedRuntimeConnectionFromOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'fixture',
      publicKeyB64: Buffer.alloc(32).toString('base64')
    }),
    { reconnect: false }
  )
  client.establish()
})
afterEach(() => {
  client.close()
  vi.unstubAllGlobals()
})

it('uses the actual parent socket for selection watch, ACK and matching ready-ID teardown', async () => {
  const onResponse = vi.fn()
  const subscription = await client.subscribe(
    'workspace.selection.watch.v1',
    {},
    { onResponse },
    { timeoutMs: 500 }
  )
  expect(sockets).toHaveLength(1)
  const parent = sockets[0]
  const watch = sent(parent, 0)
  expect(watch.method).toBe('workspace.selection.watch.v1')
  await client.deliver(
    result(watch.id, {
      type: 'ready',
      clientIncarnation: '11111111-1111-4111-8111-111111111111',
      channelNonce: '22222222-2222-4222-8222-222222222222',
      connectionId: 'native-parent',
      subscriptionId: 'native-selection-stream'
    })
  )
  const pendingAck = client.call('workspace.selection.ack.v1', { connectionId: 'native-parent' })
  await Promise.resolve()
  const ack = sent(parent, 1)
  expect(ack.method).toBe('workspace.selection.ack.v1')
  await client.deliver(result(ack.id, { acknowledged: true }))
  await pendingAck
  subscription.unsubscribe()
  await Promise.resolve()
  const teardown = sent(parent, 2)
  expect(teardown).toMatchObject({
    method: 'workspace.selection.unsubscribe.v1',
    params: { subscriptionId: 'native-selection-stream' }
  })
  await client.deliver(result(teardown.id, { unsubscribed: true }))
  expect(sockets).toHaveLength(1)
  expect(onResponse).toHaveBeenCalledTimes(1)
})

it('preserves the separate child socket for unrelated subscriptions', async () => {
  const pending = client.subscribe(
    'notifications.subscribe',
    {},
    { onResponse: () => {} },
    { timeoutMs: 500 }
  )
  const settled = expect(pending).rejects.toThrow()
  expect(sockets).toHaveLength(2)
  client.close()
  await settled
})

it('cancelling before ready waits for the native stream ID and releases that exact registration', async () => {
  const subscription = await client.subscribe(
    'workspace.selection.watch.v1',
    {},
    { onResponse: () => {} },
    { timeoutMs: 500 }
  )
  const parent = sockets[0]
  const watch = sent(parent, 0)
  subscription.unsubscribe()
  expect(parent.send).toHaveBeenCalledTimes(1)
  await client.deliver(
    result(watch.id, {
      type: 'ready',
      clientIncarnation: '11111111-1111-4111-8111-111111111111',
      channelNonce: '22222222-2222-4222-8222-222222222222',
      connectionId: 'native-parent',
      subscriptionId: 'late-stream'
    })
  )
  await Promise.resolve()
  const teardown = sent(parent, 1)
  expect(teardown.params).toEqual({ subscriptionId: 'late-stream' })
  await client.deliver(result(teardown.id, { unsubscribed: true }))
})
