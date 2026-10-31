import { describe, expect, it } from 'vitest'
import {
  isBoundOrchestrationFilesystemScope,
  OrchestrationFilesystemScopeRequestSchema
} from './orchestration-filesystem-scope'
import { WorkerStartParams } from './rpc-contract/orchestration-worker-start-params'

const roots = (...values: string[]) => ({ version: 1, kind: 'directory-roots', roots: values })

describe('OrchestrationFilesystemScopeRequestSchema', () => {
  it('accepts read-only and worktree-relative directory roots', () => {
    expect(
      OrchestrationFilesystemScopeRequestSchema.parse({ version: 1, kind: 'read-only' })
    ).toEqual({ version: 1, kind: 'read-only' })
    expect(
      OrchestrationFilesystemScopeRequestSchema.safeParse(roots('src/a', 'docs')).success
    ).toBe(true)
  })

  it.each([
    ['absolute', roots('/etc')],
    ['windows drive', roots('C:/x')],
    ['traversal', roots('src/../../x')],
    ['git metadata', roots('src/.git/hooks')],
    ['glob', roots('src/*.ts')],
    ['NUL', roots('src\0x')],
    ['empty', roots('')],
    ['overlap', roots('src', 'src/a')],
    ['worktree overlap', roots('.', 'docs')],
    ['duplicate', roots('src', './src/')],
    ['no roots', roots()],
    ['unknown version', { version: 2, kind: 'read-only' }],
    ['unknown kind', { version: 1, kind: 'files', roots: ['a.ts'] }],
    ['extra key', { version: 1, kind: 'read-only', roots: ['src'] }]
  ])('refuses %s', (_name, scope) => {
    expect(OrchestrationFilesystemScopeRequestSchema.safeParse(scope).success).toBe(false)
  })

  it('refuses scope with --on or a reused --terminal', () => {
    const base = { task: 't', from: 'term_x', filesystemScope: { version: 1, kind: 'read-only' } }
    expect(WorkerStartParams.safeParse(base).success).toBe(true)
    expect(WorkerStartParams.safeParse({ ...base, on: 'remote' }).success).toBe(false)
    expect(WorkerStartParams.safeParse({ ...base, terminal: 'term_y' }).success).toBe(false)
  })
})

describe('isBoundOrchestrationFilesystemScope', () => {
  const bound = {
    version: 1,
    kind: 'directory-roots',
    roots: ['/wt/src'],
    cwd: '/wt/src',
    worktreePath: '/wt',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    provider: 'codex'
  }

  it('accepts only an internally consistent binding', () => {
    expect(isBoundOrchestrationFilesystemScope(bound)).toBe(true)
    expect(
      isBoundOrchestrationFilesystemScope({ ...bound, roots: ['/elsewhere'], cwd: '/elsewhere' })
    ).toBe(false)
    expect(isBoundOrchestrationFilesystemScope({ ...bound, cwd: '/wt' })).toBe(false)
    expect(isBoundOrchestrationFilesystemScope({ ...bound, roots: ['/wtx'], cwd: '/wtx' })).toBe(
      false
    )
    expect(isBoundOrchestrationFilesystemScope({ ...bound, provider: 'claude' })).toBe(false)
    expect(isBoundOrchestrationFilesystemScope({ ...bound, extra: true })).toBe(false)
    expect(
      isBoundOrchestrationFilesystemScope({ ...bound, kind: 'read-only', roots: [], cwd: '/wt' })
    ).toBe(true)
    expect(isBoundOrchestrationFilesystemScope({ ...bound, kind: 'read-only' })).toBe(false)
  })
})
