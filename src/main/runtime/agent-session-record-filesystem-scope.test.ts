import { describe, expect, it } from 'vitest'
import type { BoundOrchestrationFilesystemScope } from '../../shared/orchestration-filesystem-scope'
import {
  foundAgentSessionRecord,
  type AgentSessionRecordIdentity
} from './agent-session-record-founding'
import { isReadableAgentSessionStoreRecord } from './agent-session-store-row-rules'

const identity: AgentSessionRecordIdentity = {
  sessionId: 'scope-session-1',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'wt-1',
    workspaceKind: 'git-worktree'
  },
  provider: 'codex',
  accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' }
}
const scope: BoundOrchestrationFilesystemScope = {
  version: 1,
  kind: 'directory-roots',
  roots: ['/wt/src'],
  cwd: '/wt/src',
  worktreePath: '/wt',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  provider: 'codex'
}
const lease = { claimKeyId: 'key-1', now: 1_700_000_000_000 }
const persisted = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

// Readers released through 9dd32d009d admit only schemaVersion 2 (agent-session-record.ts:273);
// the loader sets any other row aside intact and refuses every mutation of its id.
function releasedReaderAdmits(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 2
  )
}

describe('scoped agent session records across reader versions', () => {
  it('founds scoped records where released readers set them aside, and unscoped ones unchanged', () => {
    const unscoped = persisted(foundAgentSessionRecord(identity, lease))
    const scoped = persisted(
      foundAgentSessionRecord({ ...identity, filesystemScope: scope }, lease)
    )
    expect(unscoped).toMatchObject({ schemaVersion: 2 })
    expect(unscoped).not.toHaveProperty('filesystemScope')
    expect(releasedReaderAdmits(unscoped)).toBe(true)
    expect(scoped).toMatchObject({ schemaVersion: 3, filesystemScope: scope })
    expect(releasedReaderAdmits(scoped)).toBe(false)
    expect(isReadableAgentSessionStoreRecord(identity.sessionId, unscoped)).toBe(true)
    expect(isReadableAgentSessionStoreRecord(identity.sessionId, scoped)).toBe(true)
  })

  it('treats a record that drops, forges or misattributes its scope as unreadable', () => {
    const scoped = foundAgentSessionRecord({ ...identity, filesystemScope: scope }, lease)
    const unscoped = foundAgentSessionRecord(identity, lease)
    const { filesystemScope: _dropped, ...stripped } = scoped
    for (const tampered of [
      stripped,
      { ...unscoped, filesystemScope: scope },
      { ...scoped, provider: 'claude' },
      { ...scoped, filesystemScope: { ...scope, roots: ['/elsewhere'] } }
    ]) {
      expect(isReadableAgentSessionStoreRecord(identity.sessionId, persisted(tampered))).toBe(false)
    }
  })
})
