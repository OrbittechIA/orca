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
})
