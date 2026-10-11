import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUTPUT = 'legacy-child-process.cjs'
const MANIFEST = 'legacy-child-process-stage.json'

export function stageDirectoryFromArgs(args) {
  assert.equal(args.length, 2, 'Expected --stage-directory <private temporary directory>')
  assert.equal(args[0], '--stage-directory')
  const directory = path.resolve(args[1])
  assert.ok(path.isAbsolute(args[1]), 'Stage directory must be absolute')
  const roots = [tmpdir(), process.env.RUNNER_TEMP].filter(Boolean)
  assert.ok(
    roots.some((root) => {
      const relative = path.relative(path.resolve(root), directory)
      return (
        relative &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      )
    }),
    'Stage directory must be inside a temporary root'
  )
  return directory
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// One bundle keeps observer and kill-gate registrations shared by every staged export.
export async function stageLegacyProcessHost(directory) {
  stageDirectoryFromArgs(['--stage-directory', directory])
  assert.match(
    process.versions.node,
    /^24\./,
    'Stage legacy helpers with the pinned Node 24 toolchain'
  )
  const { build } = await import('esbuild')
  await mkdir(directory, { mode: 0o700 })
  const exports = [
    ['run-process', 'runProcessSync, runProcess, spawnProcess'],
    ['spawn-observer', 'setSpawnObserver, hasSpawnObserver'],
    ['process-tree-kill-gate', 'setProcessTreeKillGate, admitProcessTreeKill'],
    ['process-tree-termination', 'signalProcessTree, childProcessHasExited']
  ]
  const result = await build({
    stdin: {
      contents: exports
        .map(
          ([module, names]) =>
            `export { ${names} } from ${JSON.stringify(`./src/shared/child-process/${module}.ts`)}`
        )
        .join('\n'),
      resolveDir: ROOT,
      sourcefile: 'legacy-process-host-node18-entry.ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(directory, OUTPUT),
    metafile: true,
    logLevel: 'silent'
  })
  const inputs = []
  for (const output of Object.values(result.metafile.outputs)) {
    assert.ok(
      output.imports.every(({ path: specifier, external }) => external && isBuiltin(specifier)),
      'Staged helpers must depend only on Node builtins'
    )
  }
  for (const file of Object.keys(result.metafile.inputs).sort()) {
    if (file === 'legacy-process-host-node18-entry.ts') {
      continue
    }
    assert.ok(
      file.startsWith('src/shared/child-process/') || file === 'src/shared/growing-byte-buffer.ts',
      `Unexpected legacy staging input: ${file}`
    )
    inputs.push({ file, sha256: digest(await readFile(path.join(ROOT, file))) })
  }
  const manifest = {
    scope: 'pre-extraction-v1.4.224',
    builderNode: process.versions.node,
    target: 'node18',
    format: 'cjs',
    output: OUTPUT,
    sha256: digest(await readFile(path.join(directory, OUTPUT))),
    inputs
  }
  await writeFile(path.join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function readLegacyProcessHostStage(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, MANIFEST), 'utf8'))
  assert.equal(manifest.scope, 'pre-extraction-v1.4.224')
  assert.match(manifest.builderNode, /^24\./)
  assert.equal(manifest.target, 'node18')
  assert.equal(manifest.format, 'cjs')
  assert.equal(manifest.output, OUTPUT)
  const output = path.join(directory, OUTPUT)
  assert.equal(
    digest(await readFile(output)),
    manifest.sha256,
    'Staged legacy helper digest mismatch'
  )
  return { output, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = stageDirectoryFromArgs(process.argv.slice(2))
  const manifest = await stageLegacyProcessHost(directory)
  console.log(
    `Staged ${manifest.inputs.length} actual legacy source modules for Node 18: ${directory}`
  )
}
