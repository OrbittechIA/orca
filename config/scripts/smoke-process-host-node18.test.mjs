import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stageDirectoryFromArgs,
  stageLegacyProcessHost,
  readLegacyProcessHostStage
} from './legacy-process-host-node18-staging.mjs'
import { smokeLegacyProcessHost } from './smoke-process-host-node18.mjs'
import { runProcessSync } from './script-child-process.mjs'

const roots = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function stage() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-legacy-stage-test-'))
  roots.push(root)
  const directory = path.join(root, 'stage')
  const manifest = await stageLegacyProcessHost(directory)
  return { directory, manifest }
}
describe('staged pre-extraction process smoke', () => {
  it('bundles actual helpers once and exercises identity, refusal, cancellation, timeouts and cleanup', async () => {
    const { directory, manifest } = await stage()
    expect(manifest.target).toBe('node18')
    expect(manifest.inputs.map(({ file }) => file)).toContain(
      'src/shared/child-process/run-process.ts'
    )
    expect(
      manifest.inputs.every(
        ({ file }) =>
          file.startsWith('src/shared/child-process/') ||
          file === 'src/shared/growing-byte-buffer.ts'
      )
    ).toBe(true)
    const entry = path.join(path.dirname(directory), 'smoke-consumer.mjs')
    await writeFile(
      entry,
      [
        `import { smokeLegacyProcessHost } from ${JSON.stringify(new URL('./smoke-process-host-node18.mjs', import.meta.url).href)}`,
        'console.log(JSON.stringify(await smokeLegacyProcessHost(process.argv[2])))'
      ].join('\n')
    )
    const result = runProcessSync({
      program: process.execPath,
      args: [entry, directory],
      timeoutMs: 15_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      sync: true,
      async: true,
      sharedState: true,
      refusal: true,
      timeout: true,
      cancel: true,
      cleanup: true
    })
  })
  it('fails closed for missing or corrupted stages without a checkout fallback', async () => {
    const { directory, manifest } = await stage()
    const output = path.join(directory, manifest.output)
    await writeFile(output, `${await readFile(output, 'utf8')}\n// corrupt\n`)
    await expect(smokeLegacyProcessHost(directory)).rejects.toThrow('digest mismatch')
    await rm(directory, { recursive: true })
    await expect(readLegacyProcessHostStage(directory)).rejects.toThrow()
  })
  it('rejects a Node24 CLI invocation before consuming a stage', async () => {
    const { directory } = await stage()
    const result = runProcessSync({
      program: process.execPath,
      args: [
        fileURLToPath(new URL('./smoke-process-host-node18.mjs', import.meta.url)),
        '--stage-directory',
        directory
      ],
      timeoutMs: 5_000
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('This smoke must run under actual Node 18')
  })
  it('refuses to overwrite an existing stage', async () => {
    const { directory } = await stage()
    await expect(stageLegacyProcessHost(directory)).rejects.toThrow()
  })
  it('requires an explicit private temporary directory', () => {
    expect(() => stageDirectoryFromArgs([])).toThrow()
    expect(() => stageDirectoryFromArgs(['--stage-directory', 'relative'])).toThrow()
    expect(() =>
      stageDirectoryFromArgs(['--stage-directory', path.parse(process.cwd()).root])
    ).toThrow()
    const directory = path.join(tmpdir(), 'orca-explicit-stage')
    expect(stageDirectoryFromArgs(['--stage-directory', directory])).toBe(path.resolve(directory))
  })
})
