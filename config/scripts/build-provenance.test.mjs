import { describe, expect, it } from 'vitest'
import {
  BuildProvenanceError,
  dirtyBuildInputs,
  readBuildProvenanceLiteral
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

  it("does not count electron-vite's transient config bundle, which exists only while packaging", () => {
    // Found by the first fail-closed package: electron-vite writes `electron.vite.config.<ts>.mjs`
    // into the working directory while the config (this module's caller) loads.
    expect(dirtyBuildInputs('?? electron.vite.config.1789594574002.mjs\n')).toEqual([])
    // A modified or differently named file is still an input.
    expect(dirtyBuildInputs(' M electron.vite.config.ts\n')).toEqual([' M electron.vite.config.ts'])
    expect(dirtyBuildInputs('?? electron.vite.config.evil.mjs\n')).toEqual([
      '?? electron.vite.config.evil.mjs'
    ])
  })

  it('derives one build id from commit and tree, stable across calls', () => {
    const first = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    const second = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    expect(first.buildId).toBe(second.buildId)
    expect(first.buildId).toMatch(/^[0-9a-f]{12}$/)
  })
})
