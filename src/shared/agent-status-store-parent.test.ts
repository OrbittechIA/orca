import { describe, expect, it } from 'vitest'
import { parseAgentStatusParentInput } from './agent-status-store-parent'
import { TMUX_TEST_PANE, TMUX_TEST_ROOT } from './tmux-status.test-fixture'
const subject = { ...TMUX_TEST_ROOT.scope, kind: 'pty', paneKey: TMUX_TEST_PANE } as const

describe('canonical PTY attachment without a status claim', () => {
  it('retains the subject when its owner reports no selected status', () => {
    expect(parseAgentStatusParentInput({ subject })).toEqual({ subject })
  })
  it('still refuses a status claiming another pane', () => {
    expect(
      parseAgentStatusParentInput({
        subject,
        status: {
          paneKey: 'foreign',
          connectionId: null,
          worktreeId: 'workspace',
          state: 'done',
          prompt: '',
          receivedAt: 1,
          stateStartedAt: 1
        }
      })
    ).toBeNull()
  })
})

describe('canonical structured session identity', () => {
  const structuredSubject = {
    ...TMUX_TEST_ROOT.scope,
    kind: 'structured-session',
    sessionId: 'codex_session_1'
  } as const
  const status = {
    paneKey: TMUX_TEST_PANE,
    connectionId: null,
    worktreeId: TMUX_TEST_ROOT.scope.workspaceId,
    state: 'done',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1
  }

  it('preserves identity stamped from the canonical owner while accepting older rows', () => {
    expect(
      parseAgentStatusParentInput({ subject: structuredSubject, status })?.status
    ).not.toHaveProperty('structuredSessionId')
    expect(
      parseAgentStatusParentInput({
        subject: structuredSubject,
        status: { ...status, structuredSessionId: structuredSubject.sessionId }
      })?.status?.structuredSessionId
    ).toBe(structuredSubject.sessionId)
  })

  it('refuses an identity borrowed from another session or attached to a PTY', () => {
    const claimedStatus = { ...status, structuredSessionId: 'codex_foreign' }
    expect(
      parseAgentStatusParentInput({ subject: structuredSubject, status: claimedStatus })
    ).toBeNull()
    expect(parseAgentStatusParentInput({ subject, status: claimedStatus })).toBeNull()
  })
})
