import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { WorkItemStartAttempt } from '../tasks/work-item-start-attempt-journal'
import type { WorkItemStartStructuredSessionResult } from '../tasks/work-item-start-structured-session'

const boundary = vi.hoisted(() => ({
  hostId: 'host-a',
  worktreeId: 'workspace-a',
  read: vi.fn<(id: string) => Promise<WorkItemStartAttempt | null>>(),
  retry: vi.fn<() => Promise<WorkItemStartStructuredSessionResult | null>>()
}))
const client = new FakeSession('connected')
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ RotateCcw: () => null }))
vi.mock('../tasks/work-item-start-attempt-journal', () => ({
  readWorkItemStartAttempt: boundary.read
}))
vi.mock('../tasks/work-item-start-structured-session', () => ({
  retryWorkItemStartStructuredSession: boundary.retry
}))
vi.mock('./use-mobile-session-controller', () => ({
  useMobileSessionController: () => ({
    hostId: boundary.hostId,
    worktreeId: boundary.worktreeId,
    client,
    canDockPanel: false,
    createWarning: null
  })
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))
vi.mock('./MobileSessionHeader', () => ({ MobileSessionHeader: () => null }))
vi.mock('./MobileSessionSheets', () => ({ MobileSessionSheets: () => null }))
vi.mock('./MobileSessionActiveContent', () => ({ MobileSessionActiveContent: () => null }))
vi.mock('./MobileSessionCommandDock', () => ({ MobileSessionCommandDock: () => null }))
vi.mock('./SessionDockColumn', () => ({ SessionDockColumn: () => null }))
import { MobileSessionRouteScreen } from './MobileSessionRouteScreen'

let renderer: ReactTestRenderer | null = null
beforeEach(() => {
  boundary.hostId = 'host-a'
  boundary.worktreeId = 'workspace-a'
  boundary.retry.mockReset()
  boundary.read.mockReset().mockImplementation(async (worktreeId) => ({
    worktreeId,
    worktreeName: worktreeId,
    agent: 'codex',
    prompt: 'work item',
    sessionId: 'session-identity',
    createClientOperationId: 'original-create'
  }))
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it.each(['workspace', 'host'])('isolates an old retry reply after switching %s', async (axis) => {
  let settle: (value: WorkItemStartStructuredSessionResult) => void = () => {
    throw new Error('retry was not started')
  }
  boundary.retry.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  await act(async () => {
    renderer = create(createElement(MobileSessionRouteScreen))
  })
  const mounted = renderer
  if (!mounted) {
    throw new Error('screen was not mounted')
  }
  act(() => {
    mounted.root.findByProps({ accessibilityLabel: 'Retry Work Item Start' }).props.onPress()
  })
  expect(boundary.retry).toHaveBeenCalledOnce()
  await act(async () => {
    if (axis === 'host') {
      boundary.hostId = 'host-b'
    } else {
      boundary.worktreeId = 'workspace-b'
    }
    mounted.update(createElement(MobileSessionRouteScreen))
  })
  expect(
    mounted.root.findByProps({ accessibilityLabel: 'Retry Work Item Start' }).props.disabled
  ).toBe(false)
  await act(async () => {
    settle({ kind: 'refused', message: 'previous workspace refusal' })
  })
  expect(JSON.stringify(mounted.toJSON())).not.toContain('previous workspace refusal')
  expect(
    mounted.root.findByProps({ accessibilityLabel: 'Retry Work Item Start' }).props.disabled
  ).toBe(false)
  expect(client.sendRequest).not.toHaveBeenCalled()
})
