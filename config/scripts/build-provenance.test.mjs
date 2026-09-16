import { describe, expect, it } from 'vitest'
import { readBuildProvenanceLiteral } from './build-provenance.mjs'

const GIT = {
  'rev-parse,HEAD': 'a'.repeat(40),
  'rev-parse,HEAD^{tree}': 'b'.repeat(40)
}

function fakeGit(seen) {
  return (command, args, options) => {
    seen?.push({ command, cwd: options?.cwd })
    const answer = GIT[args.join(',')]
    if (answer === undefined) {
      throw new Error('fatal: not a git repository')
    }
    return answer
  }
}

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

  it('takes commit and tree from the environment when the packager names them', () => {
    const literal = readBuildProvenanceLiteral({
      env: { ORCA_BUILD_COMMIT: 'c'.repeat(40), ORCA_BUILD_TREE: 'd'.repeat(40) },
      run: fakeGit()
    })
    expect(JSON.parse(literal)).toMatchObject({ commit: 'c'.repeat(40), tree: 'd'.repeat(40) })
  })

  it('derives one build id from commit and tree, stable across calls', () => {
    const first = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    const second = JSON.parse(readBuildProvenanceLiteral({ env: {}, run: fakeGit() }))
    expect(first.buildId).toBe(second.buildId)
    expect(first.buildId).toMatch(/^[0-9a-f]{12}$/)
  })
})
