import { createHash } from 'node:crypto'
import { createPackage, uncache } from '@electron/asar'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linuxFormatArguments, packageLinuxFormats } from './package-linux-formats.mjs'
import { readBuildProvenanceLiteral } from './build-provenance.mjs'
import { buildCandidateManifest } from './write-candidate-manifest.mjs'
import { runProcessSync } from './script-child-process.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

let root
let sourceDirectory
let provenanceLiteral
let preparedDirectory
let outputDirectory
let preparedAsar
const targets = ['AppImage', 'deb', 'rpm']
const valueAfter = (args, flag) => args[args.indexOf(flag) + 1]

async function writePreparedAsar(literal = provenanceLiteral) {
  const contents = join(root, 'asar contents')
  mkdirSync(join(contents, 'out/main'), { recursive: true })
  writeFileSync(
    join(contents, 'out/main/index.js'),
    `const provenance = { site: 'orca:build-provenance:embed', value: ${literal} }`
  )
  const asarPath = join(preparedDirectory, 'resources/app.asar')
  uncache(asarPath)
  await createPackage(contents, asarPath)
  preparedAsar = readFileSync(asarPath)
}

beforeEach(async () => {
  vi.stubEnv('ORCA_BUILD_UNCERTIFIED', '')
  vi.stubEnv('ORCA_BUILD_COMMIT', '')
  vi.stubEnv('ORCA_BUILD_TREE', '')
  root = mkdtempSync(join(tmpdir(), 'orca formats with spaces-'))
  sourceDirectory = join(root, 'source')
  mkdirSync(sourceDirectory)
  writeFileSync(join(sourceDirectory, 'package.json'), JSON.stringify({ version: '1.4.222' }))
  for (const args of [
    ['init', '--quiet'],
    ['add', 'package.json'],
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ]
  ]) {
    const result = runProcessSync({ program: 'git', args, cwd: sourceDirectory })
    expect(result.code, result.stderr).toBe(0)
  }
  provenanceLiteral = readBuildProvenanceLiteral({ cwd: sourceDirectory })
  expect(provenanceLiteral).not.toBe('null')
  preparedDirectory = join(root, 'prepared app')
  outputDirectory = join(root, 'output packages')
  mkdirSync(join(preparedDirectory, 'resources'), { recursive: true })
  mkdirSync(outputDirectory)
  writeFileSync(join(preparedDirectory, 'resources/package-type'), 'AppImage')
  await writePreparedAsar()
  writeFileSync(join(preparedDirectory, 'orca-ide'), 'executable')
  chmodSync(join(preparedDirectory, 'orca-ide'), 0o755)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function emitPackage(args) {
  const format = valueAfter(args, '--linux')
  const app = valueAfter(args, '--prepackaged')
  const output = valueAfter(args, '--config.directories.output')
  writeFileSync(join(app, 'resources/package-type'), format)
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `orca.${format}`), format)
  writeFileSync(join(output, 'latest-linux.yml'), format)
  return { format, app, output }
}

it('preserves configured hooks, architecture, names, and PR compression with exact argv', () => {
  const args = linuxFormatArguments({
    format: 'deb',
    appDirectory: '/app with spaces',
    outputDirectory: '/out with spaces'
  })
  expect(args).toEqual([
    '--config',
    'config/electron-builder-pr-linux.config.cjs',
    '--linux',
    'deb',
    '--x64',
    '--publish',
    'never',
    '--prepackaged',
    '/app with spaces',
    '--config.directories.output',
    '/out with spaces',
    '--config.deb.compression=gz',
    '--config.rpm.compression=gzip'
  ])
  expect(() => linuxFormatArguments({ format: 'zip' })).toThrow('Unsupported Linux package format')
})

describe('independent Linux package formats', () => {
  it('binds every format to its copied ASAR before building and ignores stale parent metadata', async () => {
    const staleSidecar = JSON.stringify({ appContentSha256: '0'.repeat(64), appContentBytes: 1 })
    writeFileSync(join(outputDirectory, 'app-content.linux-x64.json'), staleSidecar)
    writeFileSync(join(outputDirectory, 'old.deb'), 'previous package')
    const seen = []
    await packageLinuxFormats({
      sourceDirectory,
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async () => ({}),
      runBuilder: async (args) => {
        const output = valueAfter(args, '--config.directories.output')
        const app = valueAfter(args, '--prepackaged')
        const copiedAsar = readFileSync(join(app, 'resources/app.asar'))
        const sidecar = JSON.parse(readFileSync(join(output, 'app-content.linux-x64.json'), 'utf8'))
        expect(sidecar).toEqual({
          platform: 'linux',
          arch: 'x64',
          appContentSha256: sha256(copiedAsar),
          appContentBytes: copiedAsar.length
        })
        const { format } = emitPackage(args)
        const manifest = buildCandidateManifest({
          distDir: output,
          artifactPaths: [join(output, `orca.${format}`)],
          provenanceLiteral
        })
        expect(manifest.artifacts).toEqual([
          expect.objectContaining({
            artifact: `orca.${format}`,
            appContentSha256: sha256(preparedAsar),
            appContentBytes: preparedAsar.length
          })
        ])
        writeFileSync(join(output, 'candidate-manifest.json'), JSON.stringify(manifest))
        seen.push(format)
      }
    })
    expect(seen.sort()).toEqual(targets.slice().sort())
    for (const format of targets) {
      const metadata = join(outputDirectory, 'linux-package-formats', format)
      const sidecar = JSON.parse(readFileSync(join(metadata, 'app-content.linux-x64.json'), 'utf8'))
      expect(sidecar.appContentSha256).toBe(sha256(preparedAsar))
      expect(
        JSON.parse(readFileSync(join(metadata, 'candidate-manifest.json'), 'utf8')).artifacts
      ).toHaveLength(1)
    }
    expect(readFileSync(join(outputDirectory, 'app-content.linux-x64.json'), 'utf8')).toBe(
      staleSidecar
    )
    expect(readFileSync(join(outputDirectory, 'old.deb'), 'utf8')).toBe('previous package')
  })

  it.each(['stale bundle', 'unidentified bundle', 'uncertifiable source'])(
    'refuses %s before any builder runs',
    async (scenario) => {
      if (scenario === 'stale bundle') {
        await writePreparedAsar(
          JSON.stringify({ ...JSON.parse(provenanceLiteral), commit: 'd'.repeat(40) })
        )
      } else if (scenario === 'unidentified bundle') {
        await writePreparedAsar('null')
      } else {
        writeFileSync(join(sourceDirectory, 'package.json'), JSON.stringify({ version: 'changed' }))
      }
      const runBuilder = vi.fn()
      await expect(
        packageLinuxFormats({
          sourceDirectory,
          preparedDirectory,
          outputDirectory,
          prepareAppImageTools: async () => ({}),
          runBuilder
        })
      ).rejects.toThrow('Linux package formats failed')
      expect(runBuilder).not.toHaveBeenCalled()
      expect(readdirSync(outputDirectory)).toEqual([])
    }
  )

  it('keeps explicit uncertified development packages without claiming app-content certification', async () => {
    vi.stubEnv('ORCA_BUILD_UNCERTIFIED', '1')
    await writePreparedAsar('null')
    const seen = []
    await packageLinuxFormats({
      sourceDirectory,
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async () => ({}),
      runBuilder: async (args) => {
        const output = valueAfter(args, '--config.directories.output')
        expect(existsSync(join(output, 'app-content.linux-x64.json'))).toBe(false)
        seen.push(emitPackage(args).format)
      }
    })
    expect(seen.sort()).toEqual(targets.slice().sort())
  })

  it('starts all formats before awaiting completion and isolates metadata writes', async () => {
    if (process.platform !== 'win32') {
      symlinkSync('resources/package-type', join(preparedDirectory, 'marker-link'))
    }
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const copies = []
    await packageLinuxFormats({
      sourceDirectory,
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async () => ({}),
      runBuilder: async (args) => {
        const app = valueAfter(args, '--prepackaged')
        const format = valueAfter(args, '--linux')
        expect(readFileSync(join(app, 'resources/package-type'), 'utf8')).toBe('AppImage')
        expect(readFileSync(join(app, 'resources/app.asar'))).toEqual(preparedAsar)
        if (process.platform !== 'win32') {
          expect(readlinkSync(join(app, 'marker-link'))).toBe('resources/package-type')
          expect(statSync(join(app, 'orca-ide')).mode & 0o777).toBe(0o755)
          expect(statSync(join(app, 'resources/package-type')).ino).not.toBe(
            statSync(join(preparedDirectory, 'resources/package-type')).ino
          )
        }
        copies.push(app)
        if (copies.length === 3) {
          release()
        }
        await gate
        expect(readdirSync(outputDirectory)).toHaveLength(1)
        emitPackage(args)
        await Promise.resolve()
        expect(readFileSync(join(app, 'resources/package-type'), 'utf8')).toBe(format)
      }
    })
    expect(new Set(copies).size).toBe(3)
    expect(readFileSync(join(preparedDirectory, 'resources/package-type'), 'utf8')).toBe('AppImage')
    expect(readFileSync(join(preparedDirectory, 'resources/app.asar'))).toEqual(preparedAsar)
    for (const format of targets) {
      expect(readFileSync(join(outputDirectory, `orca.${format}`), 'utf8')).toBe(format)
      expect(
        readFileSync(
          join(outputDirectory, 'linux-package-formats', format, 'latest-linux.yml'),
          'utf8'
        )
      ).toBe(format)
    }
    expect(
      readdirSync(outputDirectory).some((name) => name.startsWith('.linux-package-formats-'))
    ).toBe(false)
  })

  it.each(['builder', 'tool preparation'])(
    'settles every worker before cleanup and exposes no partial artifact on %s failure',
    async (failurePhase) => {
      const finished = []
      let overlay
      let release
      const gate = new Promise((resolve) => {
        release = resolve
      })
      await expect(
        packageLinuxFormats({
          sourceDirectory,
          preparedDirectory,
          outputDirectory,
          prepareAppImageTools: async ({ directory }) => {
            overlay = directory
            mkdirSync(directory)
            writeFileSync(join(directory, 'mksquashfs'), 'private wrapper')
            if (failurePhase === 'tool preparation') {
              throw new Error('compression failed')
            }
            return { APPIMAGE_TOOLS_PATH: directory, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
          },
          runBuilder: async (args, environment) => {
            const format = valueAfter(args, '--linux')
            if (format === 'AppImage') {
              expect(environment).toEqual({
                APPIMAGE_TOOLS_PATH: overlay,
                ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool'
              })
              throw new Error('compression failed')
            }
            expect(environment).toEqual({})
            if (format === 'rpm') {
              release()
            }
            await gate
            const { app } = emitPackage(args)
            expect(existsSync(app)).toBe(true)
            expect(existsSync(overlay)).toBe(true)
            finished.push(format)
          }
        })
      ).rejects.toMatchObject({
        message: 'Linux package formats failed',
        errors: [
          expect.objectContaining({
            message: 'AppImage packaging failed',
            cause: expect.objectContaining({ message: 'compression failed' })
          })
        ]
      })
      expect(finished.sort()).toEqual(['deb', 'rpm'])
      expect(existsSync(overlay)).toBe(false)
      expect(readdirSync(outputDirectory)).toEqual([])
      expect(readFileSync(join(preparedDirectory, 'resources/package-type'), 'utf8')).toBe(
        'AppImage'
      )
    }
  )

  it('passes its private tool environment only to AppImage and removes it after success', async () => {
    const originalToolsPath = process.env.APPIMAGE_TOOLS_PATH
    let overlay
    const calls = []
    await packageLinuxFormats({
      sourceDirectory,
      preparedDirectory,
      outputDirectory,
      prepareAppImageTools: async ({ directory }) => {
        overlay = directory
        mkdirSync(directory)
        return { APPIMAGE_TOOLS_PATH: directory, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
      },
      runBuilder: async (args, environment) => {
        const format = valueAfter(args, '--linux')
        calls.push(format)
        expect(environment).toEqual(
          format === 'AppImage'
            ? { APPIMAGE_TOOLS_PATH: overlay, ORCA_PR_APPIMAGE_MKSQUASHFS: 'original tool' }
            : {}
        )
        expect(process.env.APPIMAGE_TOOLS_PATH).toBe(originalToolsPath)
        emitPackage(args)
      }
    })
    expect(calls.sort()).toEqual(targets.slice().sort())
    expect(existsSync(overlay)).toBe(false)
    expect(process.env.APPIMAGE_TOOLS_PATH).toBe(originalToolsPath)
  })

  it('rejects missing artifacts even when the builder reports success', async () => {
    await expect(
      packageLinuxFormats({
        sourceDirectory,
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async (args) => {
          const result = emitPackage(args)
          if (result.format === 'rpm') {
            writeFileSync(join(result.output, 'orca.rpm'), '')
          }
        }
      })
    ).rejects.toThrow('Linux package formats failed')
    expect(readdirSync(outputDirectory)).toEqual([])
  })

  it('does not replace existing output packages', async () => {
    writeFileSync(join(outputDirectory, 'orca.deb'), 'previous package')
    await expect(
      packageLinuxFormats({
        sourceDirectory,
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async (args) => {
          emitPackage(args)
        }
      })
    ).rejects.toThrow('Refusing to replace existing package output')
    expect(readdirSync(outputDirectory)).toEqual(['orca.deb'])
    expect(readFileSync(join(outputDirectory, 'orca.deb'), 'utf8')).toBe('previous package')
  })

  it('rejects a tree already mutated by a previous root-package build', async () => {
    writeFileSync(join(preparedDirectory, 'resources/package-type'), 'rpm')
    await expect(
      packageLinuxFormats({
        sourceDirectory,
        preparedDirectory,
        outputDirectory,
        prepareAppImageTools: async () => ({}),
        runBuilder: async () => {
          throw new Error('must not run')
        }
      })
    ).rejects.toThrow('Expected a fresh Linux directory build')
    expect(readdirSync(outputDirectory)).toEqual([])
  })
})

it('changes only CI deb/rpm compression levels without mutating release settings or hooks', () => {
  const require = createRequire(import.meta.url)
  const release = require('../electron-builder.config.cjs')
  const before = { deb: { ...release.deb }, rpm: { ...release.rpm } }
  const ci = require('../electron-builder-pr-linux.config.cjs')
  expect(release.deb).toEqual(before.deb)
  expect(release.rpm).toEqual(before.rpm)
  expect(ci).toEqual({
    ...release,
    deb: { ...release.deb, fpm: [...(release.deb.fpm ?? []), '--deb-compression-level=1'] },
    rpm: { ...release.rpm, fpm: [...(release.rpm.fpm ?? []), '--rpm-compression-level=1'] }
  })
})
