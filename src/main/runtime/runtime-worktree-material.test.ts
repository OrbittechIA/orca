import { expect, it, vi } from 'vitest'
import { planWorktreeMaterial } from './runtime-worktree-material'
import {
  WorktreeMaterialManifest,
  WorktreeMaterialRestore
} from '../../shared/rpc-contract/worktree-material-params'
import * as git from './runtime-worktree-material-git'

const manifest = WorktreeMaterialManifest.parse({
  schemaVersion: 1,
  repo: 'id:repo',
  canonicalSource: 'example.org/team/repo',
  executionHostId: 'local',
  worktreeId: 'repo::/fixture/missing',
  path: '/fixture/missing',
  branch: 'old',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  linkedIssue: 413,
  linkedReview: 411,
  historicalInstanceId: null,
  runId: 'old',
  capsuleSHA256: 'c'.repeat(64),
  expectedMetadataDigest: 'd'.repeat(64)
})

it('strict schemas require full restore tuple and explicit UUID; never accepts bypass flags', () => {
  expect(WorktreeMaterialManifest.safeParse({ ...manifest, force: true }).success).toBe(false)
  expect(WorktreeMaterialRestore.safeParse({ manifest }).success).toBe(false)
  expect(
    WorktreeMaterialRestore.safeParse({
      manifest,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).success
  ).toBe(false)
  expect(
    WorktreeMaterialManifest.safeParse({
      ...manifest,
      canonicalSource: 'https://user:password@example.org/team/repo'
    }).success
  ).toBe(false)
})

it.each(['ssh:host', 'runtime:host', 'unknown'])(
  'refuses %s before using local filesystem as proof',
  async (executionHostId) => {
    const inspect = vi.spyOn(git, 'inspectMaterialGit')
    const repos = [
      { id: 'repo', path: '/fixture/repo', displayName: '', badgeColor: '', addedAt: 1 }
    ]
    expect(
      await planWorktreeMaterial({ repos, snapshot: null }, { ...manifest, executionHostId })
    ).toMatchObject({ code: 'E_MATERIAL_HOST_UNSUPPORTED', wouldWrite: false })
    expect(inspect).not.toHaveBeenCalled()
    inspect.mockRestore()
  }
)

it('folder and missing metadata stay unverifiable with no create or liveness claim', async () => {
  const repo = { id: 'repo', path: '/fixture/repo', displayName: '', badgeColor: '', addedAt: 1 }
  expect(
    (await planWorktreeMaterial({ repos: [{ ...repo, kind: 'folder' }], snapshot: null }, manifest))
      .code
  ).toBe('E_MATERIAL_HOST_UNSUPPORTED')
  expect(await planWorktreeMaterial({ repos: [repo], snapshot: null }, manifest)).toMatchObject({
    code: 'E_MATERIAL_METADATA_UNVERIFIABLE',
    coverage: { git: false, processes: 'unverifiable' }
  })
})
