import { describe, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import type { BoundOrchestrationFilesystemScope } from '../../../../shared/orchestration-filesystem-scope'
import {
  assertFilesystemScopeReservable,
  assertFilesystemScopeUnchanged
} from './agent-session-filesystem-scope-admission'

const scope: BoundOrchestrationFilesystemScope = {
  version: 1,
  kind: 'read-only',
  roots: [],
  cwd: '/wt',
  worktreePath: '/wt',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  provider: 'codex'
}
const conflict = {
  refusal: expect.objectContaining({
    code: 'agent_session_conflict',
    details: { reason: 'identityMismatch' }
  })
}

describe('agent session filesystem scope admission', () => {
  it('admits a scope only for a fresh codex conversation', () => {
    expect(() =>
      assertFilesystemScopeReservable({ provider: 'codex', filesystemScope: scope })
    ).not.toThrow()
    expect(() =>
      assertFilesystemScopeReservable({ provider: 'claude', filesystemScope: scope })
    ).toThrow(expect.objectContaining(conflict))
    expect(() =>
      assertFilesystemScopeReservable({
        provider: 'codex',
        filesystemScope: scope,
        adoptedHandleLink: {
          linkId: 'codex-1-thread',
          handle: codexProviderHandle('thread'),
          origin: 'adopted',
          mintedAtFence: 1,
          observedAt: 0
        }
      })
    ).toThrow(expect.objectContaining(conflict))
    expect(() =>
      assertFilesystemScopeReservable({
        provider: 'codex',
        filesystemScope: { ...scope, cwd: '/x' }
      })
    ).toThrow(expect.objectContaining(conflict))
  })

  it('never retrofits or changes a scope, while internal reacquisition keeps the stored one', () => {
    expect(() => assertFilesystemScopeUnchanged({}, { filesystemScope: scope })).toThrow(
      expect.objectContaining(conflict)
    )
    expect(() =>
      assertFilesystemScopeUnchanged(
        { filesystemScope: scope },
        { filesystemScope: { ...scope, dispatchId: 'ctx_2' } }
      )
    ).toThrow(expect.objectContaining(conflict))
    expect(() =>
      assertFilesystemScopeUnchanged({ filesystemScope: scope }, { filesystemScope: { ...scope } })
    ).not.toThrow()
    expect(() => assertFilesystemScopeUnchanged({ filesystemScope: scope }, {})).not.toThrow()
  })
})
