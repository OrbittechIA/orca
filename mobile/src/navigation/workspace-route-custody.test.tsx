import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { mobileWorkspaceSelection } from '../transport/workspace-selection-custody'
import { WorkspaceRoute } from './workspace-route'

const fixture = vi.hoisted(() => {
  const state: { params: { worktreeId: string }; client: unknown } = {
    params: { worktreeId: 'target' },
    client: null
  }
  return state
})
vi.mock('expo-router', () => ({ useLocalSearchParams: () => fixture.params }))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: fixture.client, state: 'connected' })
}))
vi.mock('../transport/workspace-server', () => ({
  useWorkspaceServer: () => ({ routeHost: undefined, server: null })
}))
vi.mock('../mobile-web-shell/PageRouteUnavailableScreen', () => ({
  PageRouteUnavailableScreen: ({ message }: { message: string }) =>
    createElement('refusal', null, message)
}))
const channelNonce = '11111111-1111-4111-8111-111111111111'
const fence = {
  resource: {
    worktreeId: 'target',
    path: '/fixture',
    instanceId: 'one',
    hostId: 'local',
    owner: 'orchestration',
    product: 'product',
    task: 'task',
    generation: 'one'
  },
  token: '22222222-2222-4222-8222-222222222222',
  authorityId: channelNonce,
  capturedAt: 1,
  expiresAt: 2
}
const trees: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const tree of trees.splice(0)) {
      tree.unmount()
    }
  })
})
function selection() {
  const session = new FakeSession('connected')
  session.sendRequest.mockResolvedValue({
    id: 'fixture',
    ok: true,
    result: { reported: true, acknowledged: true, reconciled: true }
  })
  fixture.client = session
  fixture.params.worktreeId = 'target'
  const client = mobileWorkspaceSelection(session)
  client.receive({
    type: 'ready',
    channelNonce,
    clientIncarnation: client.incarnation,
    connectionId: 'fixture-connection'
  })
  const hold = () =>
    client.receive({
      type: 'fence',
      round: {
        nonce: '33333333-3333-4333-8333-333333333333',
        channelNonce,
        clientIncarnation: client.incarnation,
        connectionId: 'fixture-connection',
        fence
      }
    })
  return { session, client, hold }
}
const screen = () => createElement(WorkspaceRoute, null, createElement('workspace-content'))
async function mount(): Promise<ReactTestRenderer> {
  await act(async () => {
    trees.push(create(screen()))
  })
  const [tree] = trees
  return tree
}

it('refuses a new fenced deep link before mounting its content and admits an unrelated route', async () => {
  const f = selection()
  expect(f.hold()?.disposition).toBe('absent')
  const tree = await mount()
  expect(tree.root.findAllByType('workspace-content')).toHaveLength(0)
  expect(f.client.hasMounted('target')).toBe(false)
  fixture.params.worktreeId = 'other'
  await act(async () => {
    tree.update(screen())
  })
  expect(tree.root.findAllByType('workspace-content')).toHaveLength(1)
  expect(f.client.hasMounted('other')).toBe(true)
  expect(f.session.close).not.toHaveBeenCalled()
})

it('keeps an already mounted background consumer alive and reports HELD', async () => {
  const f = selection()
  const tree = await mount()
  expect(f.client.hasMounted('target')).toBe(true)
  await act(async () => {
    expect(f.hold()?.disposition).toBe('held')
  })
  expect(tree.root.findAllByType('workspace-content')).toHaveLength(1)
  expect(f.client.canSelect('target')).toBe(false)
  expect(f.client.hasMounted('target')).toBe(true)
  expect(f.session.close).not.toHaveBeenCalled()
})
