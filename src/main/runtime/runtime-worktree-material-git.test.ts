import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
  stat,
  utimes
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import * as gitRunner from '../git/runner'
import { inspectMaterialGit, restoreMaterialGit } from './runtime-worktree-material-git'
import { planWorktreeMaterial } from './runtime-worktree-material'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { MaterialAuthority } from './runtime-worktree-material'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(extraNames: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'orca-material-git-'))
  roots.push(root)
  const config = join(root, 'empty-gitconfig')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_SYSTEM', config)
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = async (...args: string[]) =>
    (await gitExecFileAsync(args, { cwd: repo })).stdout.trim()
  await git('init', '--quiet')
  await git('config', 'user.email', 'fixture@example.invalid')
  await git('config', 'user.name', 'Fixture')
  await git('remote', 'add', 'origin', 'https://example.org/team/repo.git')
  await writeFile(join(repo, 'file.txt'), 'original\n')
  for (const name of extraNames) {
    await mkdir(join(repo, name, '..'), { recursive: true })
    await writeFile(join(repo, name), 'plain blob\n')
  }
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'base')
  const target = join(root, 'historical')
  await git('worktree', 'add', '-b', 'historical', target)
  const head = await git('rev-parse', 'historical')
  const tree = await git('rev-parse', 'historical^{tree}')
  const admin = (await readFile(join(target, '.git'), 'utf8')).trim().slice(8)
  const indexBefore = await readFile(join(admin, 'index'))
  const hooks = join(root, 'hooks')
  await mkdir(hooks)
  await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\ntouch "$PWD/hook-called"\n', {
    mode: 0o755
  })
  await git('config', 'core.hooksPath', hooks)
  await rm(target, { recursive: true })
  const metadata: WorktreeMeta = {
    instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hostId: 'local',
    displayName: 'Old name',
    comment: 'merged review is historical evidence',
    linkedIssue: 413,
    linkedPR: 411,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 7
  }
  const manifest: MaterialManifest = {
    schemaVersion: 1,
    repo: 'id:fixture',
    canonicalSource: 'example.org/team/repo',
    executionHostId: 'local',
    worktreeId: `fixture::${target}`,
    path: target,
    branch: 'historical',
    head,
    tree,
    linkedIssue: 413,
    linkedReview: 411,
    historicalInstanceId: metadata.instanceId ?? null,
    runId: 'old-run',
    capsuleSHA256: 'a'.repeat(64),
    expectedMetadataDigest: hashCanonical(metadata)
  }
  const repoRow = {
    id: 'fixture',
    path: repo,
    displayName: 'Fixture',
    badgeColor: '',
    addedAt: 1,
    executionHostId: 'local' as const
  }
  const authority: MaterialAuthority = {
    repos: [repoRow],
    snapshot: {
      repo: { ...repoRow, kind: 'git', expectedRepo: repoRow },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: planner reads metadata only, never routing settings.
      routing: {} as never,
      metadata: [
        {
          worktreeId: manifest.worktreeId,
          expectedAliases: [],
          expectedLegacy: {
            expectedPresent: true,
            expectedMeta: metadata,
            expectedSerialized: JSON.stringify(metadata),
            expectedInstanceId: metadata.instanceId,
            expectedHostId: 'local'
          }
        }
      ]
    }
  }
  return { root, repo, git, target, admin, indexBefore, manifest, metadata, authority }
}

it('refuses stale admin after merged review with exact path/head/index and metadata preserved', async () => {
  const f = await fixture()
  const before = structuredClone(f.authority)
  const result = await planWorktreeMaterial(f.authority, f.manifest)
  expect(result).toMatchObject({
    state: 'blocked',
    code: 'E_MATERIAL_CENSUS_UNVERIFIABLE',
    wouldWrite: false,
    materializable: false,
    coverage: { git: true, hostMetadata: 'aliased-local', processes: 'unverifiable' }
  })
  await expect(f.git('worktree', 'add', f.target, 'historical')).rejects.toThrow()
  expect(existsSync(f.target)).toBe(false)
  expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
  expect(await f.git('rev-parse', 'historical')).toBe(f.manifest.head)
  expect(f.authority).toEqual(before)
  expect(existsSync(join(f.repo, 'hook-called'))).toBe(false)
})

it('link in a plain filename is not a split-index extension and restores unchanged blobs', async () => {
  const f = await fixture(['docs/links.md', 'linker.c'])
  const proof = await inspectMaterialGit(f.repo, f.manifest)
  expect(proof.route).toBe('checkout-index')
  await restoreMaterialGit(f.repo, f.manifest, proof, vi.fn(), vi.fn())
  for (const name of ['docs/links.md', 'linker.c']) {
    expect(await readFile(join(f.target, name), 'utf8')).toBe('plain blob\n')
  }
  expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
})

it.each(['', '=', '=false', '=true'])(
  'refuses promisor presence (%s), including a bare boolean, before object reads',
  async (setting) => {
    const f = await fixture()
    const config = join(f.repo, '.git', 'config')
    await writeFile(
      config,
      `${await readFile(config, 'utf8')}\n[remote "origin"]\n\tpromisor${setting}\n`
    )
    const calls = vi.spyOn(gitRunner, 'gitExecFileAsync')
    const proof = await inspectMaterialGit(f.repo, f.manifest)
    expect(
      calls.mock.calls.some(
        ([args]) =>
          args.includes('--verify') || args.includes('ls-tree') || args.includes('checkout-index')
      )
    ).toBe(false)
    expect(proof.code).toBe('E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED')
    expect(proof.digest).toBeNull()
    expect(existsSync(f.target)).toBe(false)
    expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
  }
)

it('refuses a real split index without refreshing shared index and accepts its unsplit successor', async () => {
  const f = await fixture(['linker.c'])
  await f.git(`--git-dir=${f.admin}`, `--work-tree=${f.repo}`, 'update-index', '--split-index')
  const index = await readFile(join(f.admin, 'index'))
  const shared = (await readdir(f.admin)).filter((name) => name.startsWith('sharedindex.'))
  expect(shared.length).toBeGreaterThan(0)
  const old = new Date('2000-01-01T00:00:00Z')
  for (const name of shared) {
    await utimes(join(f.admin, name), old, old)
  }
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe(
    'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
  )
  expect(await readFile(join(f.admin, 'index'))).toEqual(index)
  for (const name of shared) {
    expect((await stat(join(f.admin, name))).mtimeMs).toBe(old.getTime())
  }
  expect(existsSync(f.target)).toBe(false)
  await f.git(`--git-dir=${f.admin}`, `--work-tree=${f.repo}`, 'update-index', '--no-split-index')
  expect((await inspectMaterialGit(f.repo, f.manifest)).route).toBe('checkout-index')
})

it('compares physical and metadata generations between plan and restore', async () => {
  const f = await fixture()
  const plan = await planWorktreeMaterial(f.authority, f.manifest)
  const expected = {
    ...f.manifest,
    expectedCatalogDigest: plan.catalogDigest ?? '',
    expectedPlanDigest: plan.planDigest
  }
  expect((await planWorktreeMaterial(f.authority, expected)).code).toBe(
    'E_MATERIAL_CENSUS_UNVERIFIABLE'
  )
  await f.git('worktree', 'lock', f.target)
  expect((await planWorktreeMaterial(f.authority, expected)).code).toBe('E_MATERIAL_CAS_CONFLICT')
  expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
})

it('refuses path, branch/head, locked admin and symlink collisions without effects', async () => {
  const f = await fixture()
  await mkdir(f.target)
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_PATH_CONFLICT')
  await rm(f.target, { recursive: true })
  expect((await inspectMaterialGit(f.repo, { ...f.manifest, head: 'f'.repeat(40) })).code).toBe(
    'E_MATERIAL_REF_CONFLICT'
  )
  await f.git('worktree', 'lock', f.target)
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_ADMIN_CONFLICT')
  await symlink(f.repo, f.target, 'junction')
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_PATH_CONFLICT')
})

it('missing registration is unproven historical admin, never a new checkout fallback', async () => {
  const f = await fixture()
  const alternate = { ...f.manifest, path: join(f.root, 'other') }
  expect((await inspectMaterialGit(f.repo, alternate)).code).toBe('E_MATERIAL_ADMIN_CONFLICT')
  await f.git('branch', 'unregistered', f.manifest.head)
  const unregistered = { ...alternate, branch: 'unregistered' }
  expect((await inspectMaterialGit(f.repo, unregistered)).code).toBe(
    'E_MATERIAL_HISTORICAL_ADMIN_UNVERIFIABLE'
  )
  expect(existsSync(unregistered.path)).toBe(false)
})

it('checkout-index plus exclusive .git link preserves historical admin, HEAD and index', async () => {
  const f = await fixture()
  const adminHead = await readFile(join(f.admin, 'HEAD'))
  const adminGitdir = await readFile(join(f.admin, 'gitdir'))
  const common = await readFile(join(f.admin, 'commondir'))
  const effect = vi.fn()
  const current = vi.fn()
  await restoreMaterialGit(
    f.repo,
    f.manifest,
    await inspectMaterialGit(f.repo, f.manifest),
    effect,
    current
  )
  expect(effect).toHaveBeenCalledOnce()
  expect(current).toHaveBeenCalledTimes(3)
  expect(await readFile(join(f.target, 'file.txt'), 'utf8')).toBe('original\n')
  expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
  expect(await readFile(join(f.admin, 'HEAD'))).toEqual(adminHead)
  expect(await readFile(join(f.admin, 'gitdir'))).toEqual(adminGitdir)
  expect(await readFile(join(f.admin, 'commondir'))).toEqual(common)
  expect(await f.git('rev-parse', 'historical')).toBe(f.manifest.head)
  expect(existsSync(join(f.target, 'hook-called'))).toBe(false)
})

it('binds historical index/admin proof before reporting a checkout-index candidate', async () => {
  const f = await fixture()
  expect(await inspectMaterialGit(f.repo, f.manifest)).toMatchObject({
    code: 'E_MATERIAL_CENSUS_UNVERIFIABLE',
    route: 'checkout-index',
    complete: true
  })
  await writeFile(join(f.admin, 'index'), 'invalid index')
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe(
    'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
  )
  expect(existsSync(f.target)).toBe(false)
})

it('refuses configured checkout filters, old-Git fsmonitor hook paths, and promisor material', async () => {
  const f = await fixture()
  for (const key of ['filter.fixture.smudge', 'core.fsmonitor', 'remote.origin.promisor']) {
    await f.git('config', key, 'true')
    expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe(
      'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
    )
    await f.git('config', '--unset', key)
  }
  expect(existsSync(f.target)).toBe(false)
  expect(await readFile(join(f.admin, 'index'))).toEqual(f.indexBefore)
})

it('refuses incomplete reciprocal admin, changed HEAD, staged index and locks', async () => {
  const f = await fixture()
  const head = await readFile(join(f.admin, 'HEAD'))
  await writeFile(join(f.admin, 'HEAD'), `ref: refs/heads/foreign\n`)
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_ADMIN_CONFLICT')
  await writeFile(join(f.admin, 'HEAD'), head)
  await writeFile(join(f.admin, 'index.lock'), '')
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_ADMIN_CONFLICT')
  await rm(join(f.admin, 'index.lock'))
  await writeFile(join(f.repo, 'file.txt'), 'different staged content\n')
  await f.git(`--git-dir=${f.admin}`, `--work-tree=${f.repo}`, 'add', '--', 'file.txt')
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe('E_MATERIAL_ADMIN_CONFLICT')
  await rm(join(f.admin, 'commondir'))
  expect((await inspectMaterialGit(f.repo, f.manifest)).route).toBeUndefined()
})

it('binds only local/worktree config while separately refusing unsafe effective global config', async () => {
  const f = await fixture()
  const initial = await inspectMaterialGit(f.repo, f.manifest)
  expect(initial.route).toBe('checkout-index')
  const global = join(f.root, 'second-global')
  await writeFile(global, '[user]\n\tname = Different Host\n')
  vi.stubEnv('GIT_CONFIG_GLOBAL', global)
  expect((await inspectMaterialGit(f.repo, f.manifest)).adminDigest).toBe(initial.adminDigest)
  await f.git('config', '--local', 'user.name', 'Local Change')
  const local = await inspectMaterialGit(f.repo, f.manifest)
  expect(local.adminDigest).not.toBe(initial.adminDigest)
  await f.git('config', '--local', 'extensions.worktreeConfig', 'true')
  const noWorktreeFile = await inspectMaterialGit(f.repo, f.manifest)
  expect(noWorktreeFile.route).toBe('checkout-index')
  await writeFile(join(f.admin, 'config.worktree'), '[user]\n\tname = Historical Host\n')
  expect((await inspectMaterialGit(f.repo, f.manifest)).adminDigest).not.toBe(
    noWorktreeFile.adminDigest
  )
  await writeFile(global, '[remote "origin"]\n\tpromisor\n')
  expect((await inspectMaterialGit(f.repo, f.manifest)).code).toBe(
    'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
  )
})
