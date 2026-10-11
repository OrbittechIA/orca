import { describe, expect, it } from 'vitest'
import {
  BuildProvenanceError,
  dirtyBuildInputs,
  ELECTRON_VITE_BUILD_PROVENANCE_ENV,
  provenanceEnvironmentForElectronVite,
  readBuildProvenanceLiteral,
  readBuildProvenanceLiteralForConfigLoad
} from './build-provenance.mjs'

const GIT = {
  'rev-parse,HEAD': 'a'.repeat(40),
  'rev-parse,HEAD^{tree}': 'b'.repeat(40),
  'status,--porcelain,--untracked-files=all': ''
}

function fakeGit(seen, overrides = {}) {
  return (command, args, options) => {
    seen?.push({ command, cwd: options?.cwd })
    const answer = { ...GIT, ...overrides }[args.join(',')]
    if (answer === undefined) {
      throw new Error('fatal: not a git repository')
    }
    return answer
  }
}

const quiet = { warn: () => {} }

describe('build provenance is read from the repo, whatever loaded this module', () => {
  it('reads git in the current working directory by default', () => {
    // Why this matters: electron-vite BUNDLES the config into a temp directory, so a default
    // derived from this module's own path stops pointing at the repo. That is not a theory —
    // it silently embedded `null` and shipped a package no candidate gate could match.
    const seen = []
    const literal = readBuildProvenanceLiteral({ env: {}, run: fakeGit(seen) })
    expect(seen.every((call) => call.cwd === process.cwd())).toBe(true)
    expect(JSON.parse(literal)).toMatchObject({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) })
  })

  it('honours an explicit cwd for callers that know their root', () => {
    const seen = []
    readBuildProvenanceLiteral({ cwd: process.cwd(), env: {}, run: fakeGit(seen) })
    expect(seen[0]?.cwd).toBe(process.cwd())
  })

  it('declares absence rather than inventing an identity outside a repo', () => {
    const literal = readBuildProvenanceLiteral({
      env: {},
      run: () => {
        throw new Error('fatal: not a git repository')
      }
    })
    expect(literal).toBe('null')
  })

  it('accepts an environment override only when the repository agrees with it', () => {
    const literal = readBuildProvenanceLiteral({
      env: { ORCA_BUILD_COMMIT: 'a'.repeat(40), ORCA_BUILD_TREE: 'b'.repeat(40) },
      run: fakeGit()
    })
    expect(JSON.parse(literal)).toMatchObject({ commit: 'a'.repeat(40), tree: 'b'.repeat(40) })
  })

  it('refuses an environment override that contradicts the repository', () => {
    // An override is an assertion of what CI expects to package, never a source of identity:
    // accepting it would embed a commit that was not built.
    expect(() =>
      readBuildProvenanceLiteral({
        env: { ORCA_BUILD_COMMIT: 'c'.repeat(40) },
        run: fakeGit()
      })
    ).toThrow(BuildProvenanceError)
    expect(() =>
      readBuildProvenanceLiteral({
        env: { ORCA_BUILD_TREE: 'd'.repeat(40) },
        run: fakeGit()
      })
    ).toThrow(/ORCA_BUILD_TREE/)
  })

  it('refuses an environment override that no repository can confirm', () => {
    expect(() =>
      readBuildProvenanceLiteral({
        env: { ORCA_BUILD_COMMIT: 'c'.repeat(40) },
        run: () => {
          throw new Error('fatal: not a git repository')
        }
      })
    ).toThrow(BuildProvenanceError)
  })

  it('declares no identity when a tracked source file differs from HEAD', () => {
    // Independent reproduction of the finding: edit a tracked source, package, and get the
    // same provenance as the untouched commit. A dirty tree now yields `null`, which every
    // certification gate refuses.
    const warnings = []
    const literal = readBuildProvenanceLiteral({
      env: {},
      run: fakeGit(undefined, {
        'status,--porcelain,--untracked-files=all': ' M src/main/index.ts\n'
      }),
      warn: (message) => warnings.push(message)
    })
    expect(literal).toBe('null')
    expect(warnings[0]).toContain('src/main/index.ts')
  })

  it('declares no identity for an untracked file that is not ignored', () => {
    const literal = readBuildProvenanceLiteral({
      env: {},
      run: fakeGit(undefined, {
        'status,--porcelain,--untracked-files=all': '?? src/main/injected.ts\n'
      }),
      ...quiet
    })
    expect(literal).toBe('null')
  })

  it('lists every dirty input it saw', () => {
    expect(dirtyBuildInputs(' M a.ts\n?? b.ts\n\n')).toEqual([' M a.ts', '?? b.ts'])
    expect(dirtyBuildInputs('')).toEqual([])
  })

  it('counts a numeric lookalike of the electron-vite transient as a dirty input', () => {
    // Re-review counterexample: a name-based whitelist let ANY `electron.vite.config.<digits>.mjs`
    // hide from the check. No name is exempt; the genuine transient is kept out by timing.
    const lookalike = '?? electron.vite.config.123456789.mjs\n'
    expect(dirtyBuildInputs(lookalike)).toEqual(['?? electron.vite.config.123456789.mjs'])
    expect(
      readBuildProvenanceLiteral({
        env: {},
        run: fakeGit(undefined, { 'status,--porcelain,--untracked-files=all': lookalike }),
        ...quiet
      })
    ).toBe('null')
    expect(dirtyBuildInputs(' M electron.vite.config.ts\n')).toEqual([' M electron.vite.config.ts'])
  })

  it('derives one build id from commit and tree, stable across calls', () => {
    const first = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    const second = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    expect(first.buildId).toBe(second.buildId)
    expect(first.buildId).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('the config load takes its identity from the build wrapper, validated against git', () => {
  const genuineTransient = {
    'status,--porcelain,--untracked-files=all': '?? electron.vite.config.1789594574002.mjs\n'
  }
  const handed = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))

  it('reads the identity before electron-vite runs and hands it over through the environment', () => {
    const env = provenanceEnvironmentForElectronVite({
      env: { PATH: '/bin' },
      run: fakeGit(),
      ...quiet
    })
    expect(env.PATH).toBe('/bin')
    expect(JSON.parse(env[ELECTRON_VITE_BUILD_PROVENANCE_ENV])).toEqual(handed)
  })

  it('accepts the handed-over identity while the genuine transient bundle is on disk', () => {
    // The real packaging path: the wrapper read a clean tree, electron-vite then wrote its
    // transient bundle, and the config loads while it exists. Git now reports it, and the
    // strict read would answer null — the handed identity still names this commit and tree.
    const literal = readBuildProvenanceLiteralForConfigLoad({
      env: { [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: JSON.stringify(handed) },
      run: fakeGit(undefined, genuineTransient),
      ...quiet
    })
    expect(JSON.parse(literal)).toEqual(handed)
    expect(
      readBuildProvenanceLiteral({ env: {}, run: fakeGit(undefined, genuineTransient), ...quiet })
    ).toBe('null')
  })

  it('refuses a handed-over identity for another commit or tree', () => {
    for (const forged of [
      { ...handed, commit: 'c'.repeat(40) },
      { ...handed, tree: 'd'.repeat(40) }
    ]) {
      expect(() =>
        readBuildProvenanceLiteralForConfigLoad({
          env: { [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: JSON.stringify(forged) },
          run: fakeGit(),
          ...quiet
        })
      ).toThrow(BuildProvenanceError)
    }
  })

  it('refuses a malformed hand-over and one no repository can confirm', () => {
    for (const bad of ['{', '{"version":"1"}', '[]', JSON.stringify({ ...handed, extra: 1 })]) {
      expect(() =>
        readBuildProvenanceLiteralForConfigLoad({
          env: { [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: bad },
          run: fakeGit(),
          ...quiet
        })
      ).toThrow(BuildProvenanceError)
    }
    expect(() =>
      readBuildProvenanceLiteralForConfigLoad({
        env: { [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: JSON.stringify(handed) },
        run: () => {
          throw new Error('fatal: not a git repository')
        },
        ...quiet
      })
    ).toThrow(BuildProvenanceError)
  })

  it('passes a null hand-over through, and falls back to the strict read without one', () => {
    expect(
      readBuildProvenanceLiteralForConfigLoad({
        env: { [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: 'null' },
        run: fakeGit(),
        ...quiet
      })
    ).toBe('null')
    // A direct `electron-vite build` (no wrapper): the transient makes the tree dirty → null.
    expect(
      readBuildProvenanceLiteralForConfigLoad({
        env: {},
        run: fakeGit(undefined, genuineTransient),
        ...quiet
      })
    ).toBe('null')
    expect(
      JSON.parse(readBuildProvenanceLiteralForConfigLoad({ env: {}, run: fakeGit() }))
    ).toEqual(handed)
  })
})
