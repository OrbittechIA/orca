// Every packaging lane hands the packager a FULL commit sha as ORCA_BUILD_COMMIT, and the
// provenance check refuses anything shorter rather than prefix-matching it.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { getAdhocBuildIdentity } from './adhoc-build-version.mjs'
import { BuildProvenanceError, readBuildProvenanceLiteral } from './build-provenance.mjs'
import { getDailyBuildIdentity } from './daily-build-version.mjs'
import { getHourlyBuildIdentity } from './hourly-build-version.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const workflowsDir = join(projectDir, '.github/workflows')
const FULL_SHA = /^[0-9a-f]{40}$/
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectDir,
  encoding: 'utf8'
}).trim()
const TREE = 'b'.repeat(40)

function fakeGit(commit) {
  const answers = {
    'rev-parse,HEAD': commit,
    'rev-parse,HEAD^{tree}': TREE,
    'status,--porcelain,--untracked-files=all': ''
  }
  return (_command, args) => {
    const answer = answers[args.join(',')]
    if (answer === undefined) {
      throw new Error('fatal: not a git repository')
    }
    return answer
  }
}

describe('dev-channel version scripts', () => {
  const now = new Date('2026-09-20T12:00:00Z')
  it.each([
    ['hourly', () => getHourlyBuildIdentity(now, { packageVersion: '1.4.209' })],
    ['daily', () => getDailyBuildIdentity(now, { packageVersion: '1.4.209' })],
    ['adhoc', () => getAdhocBuildIdentity(now, 'label', [])]
  ])('%s emits the full HEAD sha and keeps a short display name', (_channel, identity) => {
    const { commit, name } = identity()
    expect(commit).toMatch(FULL_SHA)
    expect(commit).toBe(HEAD)
    expect(name.endsWith(` • ${HEAD.slice(0, 7)}`)).toBe(true)
  })
})

describe('build provenance commit/tree overrides', () => {
  const commit = 'a'.repeat(40)
  it.each([
    ['a 12-character prefix of HEAD', { ORCA_BUILD_COMMIT: commit.slice(0, 12) }],
    ['a branch name', { ORCA_BUILD_COMMIT: 'main' }],
    ['an uppercase sha', { ORCA_BUILD_COMMIT: commit.toUpperCase() }],
    ['a short tree', { ORCA_BUILD_TREE: TREE.slice(0, 12) }]
  ])('refuses %s with a full-sha error instead of prefix-matching', (_label, env) => {
    expect(() => readBuildProvenanceLiteral({ env, run: fakeGit(commit) })).toThrow(
      BuildProvenanceError
    )
    expect(() => readBuildProvenanceLiteral({ env, run: fakeGit(commit) })).toThrow(
      /full 40-character/
    )
  })

  it('accepts the full commit and tree the repository reports', () => {
    const literal = readBuildProvenanceLiteral({
      env: { ORCA_BUILD_COMMIT: commit, ORCA_BUILD_TREE: TREE },
      run: fakeGit(commit)
    })
    expect(JSON.parse(literal)).toMatchObject({ commit, tree: TREE })
  })
})

function jobsSettingBuildCommit() {
  const found = []
  for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(workflowsDir, file), 'utf8')
    const workflow = parse(text)
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const value = step.env?.ORCA_BUILD_COMMIT
        if (value !== undefined) {
          found.push({ file, text, jobName, steps: job.steps, value: String(value) })
        }
      }
    }
  }
  return found
}

describe('workflow ORCA_BUILD_COMMIT sources', () => {
  const lanes = jobsSettingBuildCommit()

  it('covers the three mac lanes and the Windows dev-channel lane', () => {
    expect(new Set(lanes.map((lane) => lane.file))).toEqual(
      new Set([
        'hourly-mac-build.yml',
        'daily-mac-build.yml',
        'adhoc-mac-build.yml',
        'dev-channel-win-build.yml'
      ])
    )
  })

  it.each(lanes.map((lane) => [`${lane.file}#${lane.jobName}`, lane]))(
    '%s derives it from a full-sha source',
    (_label, lane) => {
      const stepOutput = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.commit\s*\}\}$/.exec(lane.value)
      if (stepOutput) {
        // A version-script output in the same job, which now emits `git rev-parse HEAD`.
        const producer = lane.steps.find((step) => step.id === stepOutput[1])
        expect(producer?.run).toMatch(/config\/scripts\/(hourly|daily|adhoc)-build-version\.mjs/)
        return
      }
      // Otherwise only a dispatch ref the same workflow validates as a full sha.
      expect(lane.value).toMatch(/^\$\{\{\s*inputs\.ref\s*\}\}$/)
      expect(lane.text).toContain('=~ ^[0-9a-f]{40}$')
    }
  )
})
