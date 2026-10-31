import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { sendRequest } from './transport'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:net', () => ({ createConnection: connect }))
class Socket extends EventEmitter {
  setEncoding = vi.fn()
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
}
const metadata: RuntimeMetadata = {
  runtimeId: 'runtime',
  pid: 1,
  startedAt: 1,
  authToken: 'owner',
  transports: [{ kind: 'unix', endpoint: 'fixture' }]
}
let socket: Socket
beforeEach(() => {
  socket = new Socket()
  connect.mockReturnValue(socket)
})
const response = (id: string, result: unknown) =>
  `${JSON.stringify({
    id,
    ok: true,
    result,
    _meta: { runtimeId: metadata.runtimeId }
  })}\n`

it('acknowledges headless selection on the actual custody socket before sending custody', async () => {
  const pending = sendRequest(metadata, 'worktree.custody.v1', { operation: 'list' }, 1000)
  socket.emit('connect')
  expect(socket.write).toHaveBeenCalledTimes(1)
  const declaration = JSON.parse(socket.write.mock.calls[0][0])
  expect(declaration).toMatchObject({
    method: 'workspace.selection.report.v1',
    params: { kind: 'headless', workspaceIds: [] }
  })
  socket.emit('data', response(declaration.id, { reported: true }))
  expect(socket.write).toHaveBeenCalledTimes(2)
  const custody = JSON.parse(socket.write.mock.calls[1][0])
  expect(custody.method).toBe('worktree.custody.v1')
  expect(custody.id).not.toBe(declaration.id)
  socket.emit('data', response(custody.id, { supported: false }))
  await expect(pending).resolves.toMatchObject({ result: { supported: false } })
  expect(connect).toHaveBeenCalledTimes(1)
})

it('does not send custody when the same host refuses or cannot acknowledge selection', async () => {
  const pending = sendRequest(metadata, 'worktree.custody.v1', { operation: 'capture' }, 1000)
  socket.emit('connect')
  const declaration = JSON.parse(socket.write.mock.calls[0][0])
  socket.emit(
    'data',
    `${JSON.stringify({
      id: declaration.id,
      ok: false,
      error: { code: 'method_not_found', message: 'old host' }
    })}\n`
  )
  await expect(pending).rejects.toMatchObject({ code: 'custody_selection_unavailable' })
  expect(socket.write).toHaveBeenCalledTimes(1)
})

it('preserves the one-request path for normal Start operations', async () => {
  const pending = sendRequest(metadata, 'terminal.create', {}, 1000)
  socket.emit('connect')
  const request = JSON.parse(socket.write.mock.calls[0][0])
  expect(request.method).toBe('terminal.create')
  socket.emit('data', response(request.id, {}))
  await expect(pending).resolves.toMatchObject({ ok: true })
  expect(socket.write).toHaveBeenCalledTimes(1)
})
