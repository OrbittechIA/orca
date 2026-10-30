import { expect, it } from 'vitest'
import type { StructuredAgentSessionLaunchAuthority } from '../../../../shared/structured-agent-session-create'
import {
  canAccessWorkItemStartStructuredRecord,
  structuredWorkItemStartCallerAuthority
} from './structured-agent-session-launch-authority'
import { projectStructuredAgentSessionStatusAudience } from './structured-agent-session-status-audience'

const owner = { caller: { kind: 'paired-device', deviceId: 'owner' } } as const
const other = { caller: { kind: 'paired-device', deviceId: 'other' } } as const
const desktop = { caller: { kind: 'desktop' } } as const
const authority: StructuredAgentSessionLaunchAuthority = { kind: 'paired-device', deviceId: 'owner' }
const record = { launchOrigin: 'work-item-start', launchAuthority: authority } as const


it('requires the exact transport owner, including desktop, and never grants an unowned legacy start', () => {
  expect(canAccessWorkItemStartStructuredRecord(owner, record)).toBe(true)
  for (const caller of [other, desktop, {}, { caller: { kind: 'local-cli' as const } }]) {
    expect(canAccessWorkItemStartStructuredRecord(caller, record)).toBe(false)
  }
  expect(canAccessWorkItemStartStructuredRecord(desktop, { ...record, launchAuthority: { kind: 'local-desktop' } })).toBe(true)
  expect(canAccessWorkItemStartStructuredRecord(owner, { launchOrigin: 'work-item-start' })).toBe(false)
  expect(canAccessWorkItemStartStructuredRecord(owner, null)).toBe(false)
  expect(structuredWorkItemStartCallerAuthority({})).toBe(null)
})

it('filters every status field and incremental frame with the same owner predicate', () => {
  const rows = new Map([['owned', record], ['foreign', { ...record, launchAuthority: { kind: 'local-desktop' } as const }]])
  const reads = (id: string) => canAccessWorkItemStartStructuredRecord(owner, rows.get(id))
  const event = {
    type: 'snapshot' as const,
    sessions: ['owned', 'foreign'].map((sessionId) => ({ sessionId, workspaceId: 'folder', agent: 'codex', status: 'idle' as const, latestPrompt: 'private', updatedAt: 1 })),
    conversationNames: [{ sessionId: 'owned', conversationName: 'Visible' }, { sessionId: 'foreign', conversationName: 'Secret' }],
    namingActiveSessionIds: ['owned', 'foreign', 'missing']
  }
  expect(projectStructuredAgentSessionStatusAudience(event, reads)).toEqual({
    ...event,
    sessions: [event.sessions[0]],
    conversationNames: [event.conversationNames[0]],
    namingActiveSessionIds: ['owned']
  })
  expect(projectStructuredAgentSessionStatusAudience({ type: 'status', session: { sessionId: 'foreign', workspaceId: 'folder', agent: 'codex', status: 'idle', latestPrompt: 'private', updatedAt: 1 } }, reads)).toBe(null)
  expect(projectStructuredAgentSessionStatusAudience({ type: 'status', session: { sessionId: 'owned', workspaceId: 'folder', agent: 'codex', status: 'idle', latestPrompt: 'private', updatedAt: 1 } }, reads)?.type).toBe('status')
  expect(event.namingActiveSessionIds).toHaveLength(3)
})
