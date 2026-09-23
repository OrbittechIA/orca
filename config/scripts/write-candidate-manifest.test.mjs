import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCandidateManifest, writeAppContentSidecar } from './write-candidate-manifest.mjs'

const PROVENANCE = JSON.stringify({
  version: '1.4.209',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  buildId: 'c'.repeat(12)
})

let dist

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'orca-candidate-manifest-'))
  writeFileSync(join(dist, 'Orca-Setup-1.4.209.exe'), 'windows installer')
  writeFileSync(join(dist, 'app.asar'), 'packaged app code')
})

afterEach(() => {
  rmSync(dist, { recursive: true, force: true })
})

describe('candidate manifest app content binding', () => {
  it('merges the afterPack app.asar hash into the matching artifact', () => {
    writeAppContentSidecar({
      distDir: dist,
      electronPlatform: 'win32',
      arch: 'x64',
      asarPath: join(dist, 'app.asar')
    })
    const manifest = buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE })
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        artifact: 'Orca-Setup-1.4.209.exe',
        platform: 'windows',
        arch: 'x64',
        appContentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        appContentBytes: 'packaged app code'.length
      })
    ])
    expect(manifest.commit).toBe('a'.repeat(40))
  })

  it('refuses to write a manifest whose artifact has no app content record', () => {
    expect(() => buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE })).toThrow(
      /app-content\.windows-x64\.json/
    )
  })

  it('does not bind another platform or arch sidecar to the artifact', () => {
    writeAppContentSidecar({
      distDir: dist,
      electronPlatform: 'win32',
      arch: 'arm64',
      asarPath: join(dist, 'app.asar')
    })
    expect(() => buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE })).toThrow(
      /windows-x64/
    )
  })

  it('binds linux x64 artifacts, including rpm x86_64, to the x64 sidecar', () => {
    rmSync(join(dist, 'Orca-Setup-1.4.209.exe'))
    for (const name of [
      'orca-linux.AppImage',
      'orca-ide_1.4.209_amd64.deb',
      'orca-ide-1.4.209.x86_64.rpm'
    ]) {
      writeFileSync(join(dist, name), name)
    }
    writeAppContentSidecar({
      distDir: dist,
      electronPlatform: 'linux',
      arch: 'x64',
      asarPath: join(dist, 'app.asar')
    })
    const manifest = buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE })
    expect(manifest.artifacts.map((a) => [a.artifact, a.arch, a.appContentBytes])).toEqual([
      ['orca-ide_1.4.209_amd64.deb', 'x64', 'packaged app code'.length],
      ['orca-ide-1.4.209.x86_64.rpm', 'x64', 'packaged app code'.length],
      ['orca-linux.AppImage', 'x64', 'packaged app code'.length]
    ])
  })

  it('keeps the linux manifest shape byte-identical for every linux artifact', () => {
    rmSync(join(dist, 'Orca-Setup-1.4.209.exe'))
    writeFileSync(join(dist, 'orca-ide-1.4.209.x86_64.rpm'), 'rpm')
    writeAppContentSidecar({
      distDir: dist,
      electronPlatform: 'linux',
      arch: 'x64',
      asarPath: join(dist, 'app.asar')
    })
    const [rpm] = buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE }).artifacts
    expect(Object.keys(rpm)).toEqual([
      'artifact',
      'platform',
      'arch',
      'kind',
      'sha256',
      'bytes',
      'appContentSha256',
      'appContentBytes'
    ])
    expect(rpm).toMatchObject({ platform: 'linux', arch: 'x64', kind: 'rpm' })
  })
})

describe('candidate manifest zip platform', () => {
  const sidecar = (electronPlatform, arch) =>
    writeAppContentSidecar({
      distDir: dist,
      electronPlatform,
      arch,
      asarPath: join(dist, 'app.asar')
    })
  const zipRows = () =>
    buildCandidateManifest({ distDir: dist, provenanceLiteral: PROVENANCE })
      .artifacts.filter((a) => a.kind === 'zip')
      .map((a) => [a.artifact, a.platform, a.arch])

  beforeEach(() => {
    rmSync(join(dist, 'Orca-Setup-1.4.209.exe'))
  })

  it('binds the mac x64 and arm64 zips electron-builder writes to the macos sidecars', () => {
    writeFileSync(join(dist, 'Orca-1.4.209-mac.zip'), 'x64 zip')
    writeFileSync(join(dist, 'Orca-1.4.209-arm64-mac.zip'), 'arm64 zip')
    writeFileSync(join(dist, 'orca-macos-x64.dmg'), 'x64 dmg')
    writeFileSync(join(dist, 'orca-macos-arm64.dmg'), 'arm64 dmg')
    sidecar('darwin', 'x64')
    sidecar('darwin', 'arm64')
    expect(zipRows()).toEqual([
      ['Orca-1.4.209-arm64-mac.zip', 'macos', 'arm64'],
      ['Orca-1.4.209-mac.zip', 'macos', 'x64']
    ])
  })

  it('refuses a mac zip whose macos sidecar is missing, even when a windows one exists', () => {
    writeFileSync(join(dist, 'Orca-1.4.209-arm64-mac.zip'), 'arm64 zip')
    sidecar('win32', 'arm64')
    expect(zipRows).toThrow(/app-content\.macos-arm64\.json/)
  })

  it('binds a windows-named zip to the windows sidecar', () => {
    writeFileSync(join(dist, 'orca-windows-x64.zip'), 'win zip')
    sidecar('win32', 'x64')
    sidecar('darwin', 'x64')
    expect(zipRows()).toEqual([['orca-windows-x64.zip', 'windows', 'x64']])
  })

  it('binds an unnamed zip only when exactly one platform packaged that arch', () => {
    writeFileSync(join(dist, 'orca-x64.zip'), 'zip')
    sidecar('win32', 'x64')
    expect(zipRows()).toEqual([['orca-x64.zip', 'windows', 'x64']])
  })

  it('refuses an unnamed zip that both a mac and a windows sidecar could fit', () => {
    writeFileSync(join(dist, 'orca-x64.zip'), 'zip')
    sidecar('win32', 'x64')
    sidecar('darwin', 'x64')
    expect(zipRows).toThrow(/more than one x64 app-content sidecar/)
  })

  it('refuses an unnamed zip no sidecar fits, even without the app-content requirement', () => {
    writeFileSync(join(dist, 'orca-arm64.zip'), 'zip')
    sidecar('darwin', 'x64')
    expect(zipRows).toThrow(/no arm64 app-content sidecar/)
    expect(() =>
      buildCandidateManifest({
        distDir: dist,
        provenanceLiteral: PROVENANCE,
        requireAppContent: false
      })
    ).toThrow(/refusing to guess/)
  })

  it('refuses a zip whose name claims two platforms', () => {
    writeFileSync(join(dist, 'orca-win-mac-x64.zip'), 'zip')
    sidecar('darwin', 'x64')
    expect(zipRows).toThrow(/names more than one platform/)
  })
})
