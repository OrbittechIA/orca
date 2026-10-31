import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertWorkerFilesystemScopeAdmissible,
  bindWorkerFilesystemScope
} from './worker-filesystem-scope'

const ids = { taskId: 'task_1', dispatchId: 'ctx_1' }
let base: string
let worktree: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'orca-scope-')))
  worktree = join(base, 'wt')
  await mkdir(join(worktree, 'src', 'a'), { recursive: true })
  await mkdir(join(base, 'outside'))
  await mkdir(join(base, 'gitdir'))
  await writeFile(join(worktree, '.git'), `gitdir: ${join(base, 'gitdir')}\n`)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const bind = (roots: string[], worktreePath = worktree) =>
  bindWorkerFilesystemScope({
    request: { version: 1, kind: 'directory-roots', roots },
    worktreePath,
    ...ids
  })

describe('bindWorkerFilesystemScope', () => {
  it('binds roots to symlink-free absolute paths with the first as cwd', async () => {
    await mkdir(join(worktree, 'docs'))
    await expect(bind(['src/a', 'docs'])).resolves.toEqual({
      version: 1,
      kind: 'directory-roots',
      roots: [join(worktree, 'src', 'a'), join(worktree, 'docs')],
      cwd: join(worktree, 'src', 'a'),
      worktreePath: worktree,
      provider: 'codex',
      ...ids
    })
  })

  it('binds read-only to the worktree itself', async () => {
    await expect(
      bindWorkerFilesystemScope({
        request: { version: 1, kind: 'read-only' },
        worktreePath: worktree,
        ...ids
      })
    ).resolves.toMatchObject({ kind: 'read-only', roots: [], cwd: worktree })
  })

  it('refuses a symlinked root, intermediate directory or worktree instead of following it', async () => {
    await symlink(join(base, 'outside'), join(worktree, 'escape'))
    await symlink(join(base, 'outside'), join(worktree, 'src', 'link'))
    await mkdir(join(base, 'outside', 'deep'))
    await expect(bind(['escape'])).rejects.toMatchObject({ data: { reason: 'symlink' } })
    await expect(bind(['src/link/deep'])).rejects.toMatchObject({ data: { reason: 'symlink' } })
    await symlink(worktree, join(base, 'wt-link'))
    await expect(bind(['src'], join(base, 'wt-link'))).rejects.toMatchObject({
      data: { reason: 'symlink' }
    })
  })

  it('refuses missing roots, file roots and roots holding Git metadata', async () => {
    await writeFile(join(worktree, 'file.ts'), '')
    await expect(bind(['missing'])).rejects.toMatchObject({ data: { reason: 'root_missing' } })
    await expect(bind(['file.ts'])).rejects.toMatchObject({
      data: { reason: 'root_not_directory' }
    })
    await mkdir(join(worktree, 'src', 'nested', '.git'), { recursive: true })
    await expect(bind(['src/nested'])).rejects.toMatchObject({ data: { reason: 'git_metadata' } })
  })

  it('refuses a worktree whose Git directory lies inside a root', async () => {
    await mkdir(join(worktree, 'src', 'gd'))
    await writeFile(join(worktree, '.git'), 'gitdir: src/gd\n')
    await expect(bind(['src'])).rejects.toMatchObject({ data: { reason: 'git_metadata' } })
  })

  it('refuses a binding without its Task', async () => {
    await expect(
      bindWorkerFilesystemScope({
        request: { version: 1, kind: 'read-only' },
        worktreePath: worktree,
        taskId: undefined,
        dispatchId: 'ctx_1'
      })
    ).rejects.toMatchObject({ data: { reason: 'task_unbound' } })
  })
})

describe('assertWorkerFilesystemScopeAdmissible', () => {
  it.each([
    [{ agent: 'codex', mode: 'structured', platform: 'win32' }, 'host_unsupported'],
    [{ agent: 'claude', mode: 'structured', platform: 'linux' }, 'provider_unsupported'],
    [{ agent: undefined, mode: 'structured', platform: 'linux' }, 'provider_unsupported'],
    [{ agent: 'codex', mode: 'terminal', platform: 'darwin' }, 'terminal_unsupported']
  ] as const)('refuses %o with %s', (args, reason) => {
    expect(() => assertWorkerFilesystemScopeAdmissible(args)).toThrow(
      expect.objectContaining({ code: 'filesystem_scope_refused', data: { reason } })
    )
  })

  it('admits local codex structured workers', () => {
    expect(() =>
      assertWorkerFilesystemScopeAdmissible({
        agent: 'codex',
        mode: 'structured',
        platform: 'linux'
      })
    ).not.toThrow()
  })
})
