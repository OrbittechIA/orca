import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WORKTREE_HANDLERS } from './handlers/worktree'

const paths: string[] = []
afterEach(() => {
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true })
})

it('routes missing historical material with a merged review to exact restore, never ordinary create', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-material-cli-'))
  paths.push(folder)
  const manifest = {
    schemaVersion: 1,
    repo: 'id:fixture',
    canonicalSource: 'example.org/team/repo',
    executionHostId: 'local',
    worktreeId: `fixture::${folder}/missing`,
    path: `${folder}/missing`,
    branch: 'historical-branch',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    linkedIssue: 413,
    linkedReview: 411,
    historicalInstanceId: null,
    runId: 'historical-run',
    capsuleSHA256: 'c'.repeat(64),
    expectedMetadataDigest: 'd'.repeat(64),
    expectedCatalogDigest: 'e'.repeat(64),
    expectedPlanDigest: 'f'.repeat(64)
  }
  const file = join(folder, 'manifest.json')
  writeFileSync(file, JSON.stringify(manifest))
  const call = vi
    .fn()
    .mockResolvedValue({ result: { state: 'blocked', code: 'E_MATERIAL_CENSUS_UNVERIFIABLE' } })
  const print = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    const handler = WORKTREE_HANDLERS['worktree material-restore']
    expect(
      handler,
      'ordinary create cannot restore an absent historical path/branch after review merged'
    ).toBeTypeOf('function')
    await handler({
      flags: new Map([
        ['manifest', file],
        ['request-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
      ]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this CLI fixture only consumes client.call.
      client: { call } as never,
      cwd: folder,
      json: true
    })
    expect(call).toHaveBeenCalledExactlyOnceWith(
      'worktree.materialRestore',
      { manifest, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { orchestrationRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
    )
  } finally {
    print.mockRestore()
  }
})

it('CLI rejects absent UUID without contacting runtime or substituting create', async () => {
  const call = vi.fn()
  await expect(
    WORKTREE_HANDLERS['worktree material-restore']({
      flags: new Map(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture asserts no client call occurs.
      client: { call } as never,
      cwd: '/fixture',
      json: true
    })
  ).rejects.toThrow()
  expect(call).not.toHaveBeenCalled()
})
