import { describe, expect, it } from 'vitest'
import { buildCandidateManifest } from './write-candidate-manifest.mjs'
import { verifyBundledBuildProvenance } from './verify-build-provenance.mjs'

const IDENTITY = {
  version: '1.4.203',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  buildId: '0123456789ab'
}
const literal = JSON.stringify(IDENTITY)

describe('a bundle certifies only against a clean, matching identity', () => {
  it('accepts a bundle that carries every identity field', () => {
    const bundle = `var ORCA_BUILD_PROVENANCE=${literal};`
    expect(
      verifyBundledBuildProvenance({ bundlePath: 'bundle.js', bundle, expectedLiteral: literal })
    ).toEqual(IDENTITY)
  })

  it('refuses when the tree has no provenance, which is what a dirty checkout produces', () => {
    // `readBuildProvenanceLiteral` answers `null` for a dirty tree; from here on nothing can
    // certify: the bundle gate throws, and the manifest writer refuses too.
    expect(() =>
      verifyBundledBuildProvenance({
        bundlePath: 'bundle.js',
        bundle: 'var ORCA_BUILD_PROVENANCE=null;',
        expectedLiteral: 'null'
      })
    ).toThrow(/refusing to certify/)
    expect(() => buildCandidateManifest({ distDir: '.', provenanceLiteral: 'null' })).toThrow(
      /refusing to write a manifest/
    )
  })

  it('refuses a bundle whose embedded identity is another commit', () => {
    const other = JSON.stringify({ ...IDENTITY, commit: 'c'.repeat(40), buildId: 'ffffffffffff' })
    expect(() =>
      verifyBundledBuildProvenance({
        bundlePath: 'bundle.js',
        bundle: `var ORCA_BUILD_PROVENANCE=${other};`,
        expectedLiteral: literal
      })
    ).toThrow(/commit, buildId/)
  })
})
