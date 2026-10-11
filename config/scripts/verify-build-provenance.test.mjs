import { describe, expect, it } from 'vitest'
import { BUILD_PROVENANCE_EMBED_SITE } from '../../src/shared/build-provenance'
import { buildCandidateManifest } from './write-candidate-manifest.mjs'
import {
  EMBED_SITE,
  extractEmbeddedBuildProvenance,
  verifyBundledBuildProvenance
} from './verify-build-provenance.mjs'

const IDENTITY = {
  version: '1.4.203',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  buildId: '0123456789ab'
}
const literal = JSON.stringify(IDENTITY)
const OTHER = { ...IDENTITY, commit: 'c'.repeat(40), buildId: 'ffffffffffff' }

/** What electron-vite + the minifier print at the read site (see the real bundle: backtick
 *  strings, no spaces); the verifier binds to the value right after the site sentinel. */
function site(value) {
  const printed =
    value === null
      ? 'null'
      : typeof value === 'string'
        ? value
        : `{version:\`${value.version}\`,commit:\`${value.commit}\`,tree:\`${value.tree}\`,buildId:\`${value.buildId}\`}`
  return `function V5t(){return B5t({site:\`${EMBED_SITE}\`,value:${printed}})}`
}

const verify = (bundle) =>
  verifyBundledBuildProvenance({ bundlePath: 'bundle.js', bundle, expectedLiteral: literal })

describe('the embed site sentinel is one constant on both sides', () => {
  it('matches the runtime module byte for byte', () => {
    expect(EMBED_SITE).toBe(BUILD_PROVENANCE_EMBED_SITE)
  })
})

describe('a bundle certifies only by the value at its embed site', () => {
  it('accepts the genuine minified shape and the pretty-printed one', () => {
    expect(verify(`var x=1;${site(IDENTITY)};var y=2;`)).toEqual(IDENTITY)
    expect(
      verify(
        `{ site: "${EMBED_SITE}", value: { "version": "1.4.203", "commit": "${IDENTITY.commit}", "tree": "${IDENTITY.tree}", "buildId": "${IDENTITY.buildId}" } }`
      )
    ).toEqual(IDENTITY)
  })

  it('refuses a null embed even when every expected string appears elsewhere', () => {
    // Re-review counterexample: substring presence proved nothing.
    const bundle = `${site(null)} /* unrelated strings: ${IDENTITY.version} ${IDENTITY.commit} ${IDENTITY.tree} ${IDENTITY.buildId} */`
    expect(extractEmbeddedBuildProvenance(bundle)).toEqual([null])
    expect(() => verify(bundle)).toThrow(/embeds no build identity at its read site/)
  })

  it('refuses a forged identity at the site even when the expected strings appear elsewhere', () => {
    const bundle = `${site(OTHER)} /* ${literal} */ var decoy=${literal};`
    expect(() => verify(bundle)).toThrow(/embeds another build's commit, buildId/)
  })

  it('refuses an unreplaced identifier or a malformed value at the site', () => {
    expect(() => verify(site('globalThis.ORCA_BUILD_PROVENANCE'))).toThrow(
      /embeds no build identity at its read site/
    )
    expect(() => verify(site('{version:`1.4.203`}'))).toThrow(
      /embeds no build identity at its read site/
    )
    expect(() => verify(site('void 0'))).toThrow(/embeds no build identity at its read site/)
  })

  it('refuses a bundle with no embed site, and one with two', () => {
    expect(() => verify(`var ORCA_BUILD_PROVENANCE=${literal};`)).toThrow(
      /no build provenance embed site/
    )
    expect(() => verify(`${site(IDENTITY)}${site(IDENTITY)}`)).toThrow(
      /2 build provenance embed sites/
    )
    expect(() => verify(`${site(IDENTITY)}${site(OTHER)}`)).toThrow(
      /2 build provenance embed sites/
    )
  })

  it('refuses when the tree has no provenance, which is what a dirty checkout produces', () => {
    expect(() =>
      verifyBundledBuildProvenance({
        bundlePath: 'bundle.js',
        bundle: site(IDENTITY),
        expectedLiteral: 'null'
      })
    ).toThrow(/refusing to certify/)
    expect(() => buildCandidateManifest({ distDir: '.', provenanceLiteral: 'null' })).toThrow(
      /refusing to write a manifest/
    )
  })
})
