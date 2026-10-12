import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WORKTREE_HANDLERS } from './handlers/worktree'
import { RuntimeClient } from './runtime-client'

const paths: string[] = []
afterEach(() => {
  for (const p of paths.splice(0)) {
    rmSync(p, { recursive: true, force: true })
  }
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

it('rejects duplicate manifest keys before contacting runtime', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-material-duplicate-'))
  paths.push(folder)
  const file = join(folder, 'manifest.json')
  writeFileSync(
    file,
    `{"schemaVersion":0,"schemaVersion":1,"repo":"id:r","canonicalSource":"example.org/team/repo","executionHostId":"local","worktreeId":"r::/fixture/missing","path":"/fixture/missing","branch":"old","head":"${'a'.repeat(
      40
    )}","tree":"${'b'.repeat(
      40
    )}","linkedIssue":413,"linkedReview":411,"historicalInstanceId":null,"runId":"old","capsuleSHA256":"${'c'.repeat(
      64
    )}","expectedMetadataDigest":"${'d'.repeat(64)}"}`
  )
  const client = new RuntimeClient(folder, 1000, null, null, '/fixture/orca')
  const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('RPC_FORBIDDEN'))
  const print = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    await expect(
      WORKTREE_HANDLERS['worktree material-plan']({
        flags: new Map([['manifest', file]]),
        client,
        cwd: folder,
        json: true
      })
    ).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  } finally {
    print.mockRestore()
  }
})

import { execFileSync, spawnSync } from 'node:child_process'
import { build } from 'esbuild'

it('rejects a FIFO in a bounded child before any RPC', async () => {
  if (process.platform === 'win32') {
    return
  }
  const folder = mkdtempSync(join(tmpdir(), 'orca-material-fifo-'))
  paths.push(folder)
  const fifo = join(folder, 'manifest.pipe')
  execFileSync('mkfifo', [fifo], { timeout: 2000 })
  const child = join(folder, 'probe.cjs')
  await build({
    stdin: {
      contents: `
    import { WORKTREE_MATERIAL_HANDLERS } from './src/cli/handlers/worktree-material';
    WORKTREE_MATERIAL_HANDLERS['worktree material-plan']({flags:new Map([['manifest',process.argv[2]]]),
      client:{call:()=>{throw new Error('RPC_FORBIDDEN')}},json:true,cwd:process.cwd()})
      .then(()=>{process.exitCode=2}).catch(e=>{if(!e.message.includes('unchanged regular'))throw e;
        process.stdout.write('FIFO_REFUSED');});`,
      resolveDir: resolve('.'),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: child,
    logLevel: 'silent'
  })
  const result = spawnSync(process.execPath, [child, fifo], { timeout: 3000, encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('FIFO_REFUSED')
})
