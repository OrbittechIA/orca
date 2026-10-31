import { describe, expect, it } from 'vitest'
import {
  parseRunFilters,
  readRunFilters,
  RUN_ARGS_ENV,
  selectsByImportGraph
} from './vitest-run-filters.mjs'
import { matchesRunFilter } from './vitest-sqlite-runtime-scan.mjs'

describe('parseRunFilters', () => {
  it('returns the positional filters of a one-shot run', () => {
    expect(
      parseRunFilters([
        'run',
        '--config',
        'config/vitest.config.ts',
        'src/main/runtime',
        '--maxWorkers=2',
        '-t',
        'name',
        'src/shared/a.test.ts:12'
      ])
    ).toEqual(['src/main/runtime', 'src/shared/a.test.ts:12'])
  })

  it('treats an unknown option value as a filter, widening rather than narrowing the scan', () => {
    expect(parseRunFilters(['run', '--changed', 'src/a', '--unknown', '7'])).toEqual(['src/a', '7'])
  })

  it.each([
    [['run', '--config', 'x']],
    [['watch', 'src/a']],
    [['related', 'src/a.ts']],
    [['run', '--watch', 'src/a']],
    [['run', '--dir', 'src', 'a']],
    [['run', 'src/a', '--', 'b']]
  ])('scans every file for %j', (args) => {
    expect(parseRunFilters(args)).toBeUndefined()
  })

  it('ignores inherited arguments that this process was not launched with', () => {
    const args = ['run', 'src/a']
    const env = { [RUN_ARGS_ENV]: JSON.stringify(args) }
    expect(readRunFilters(env, ['bun', 'vitest.mjs', ...args])).toEqual(['src/a'])
    expect(readRunFilters(env, ['bun', 'vitest.mjs', 'run', 'src/b'])).toBeUndefined()
  })
})

describe('selectsByImportGraph', () => {
  const launched = (args) => [
    { [RUN_ARGS_ENV]: JSON.stringify(args) },
    ['node', 'vitest.mjs', ...args]
  ]

  it.each([
    [['related', '--run', 'src/a.ts']],
    [['run', '--changed=abc123']],
    [['run', '--changed', 'abc123']]
  ])('leaves dedicated-lane suites to their lanes for %j', (args) => {
    expect(selectsByImportGraph(...launched(args))).toBe(true)
  })

  it.each([
    [['run', 'src/main/runtime/structured-session-cli-login-shell.live-shell.test.ts']],
    [['run']]
  ])('keeps explicit and full runs collecting every suite for %j', (args) => {
    expect(selectsByImportGraph(...launched(args))).toBe(false)
  })

  it('ignores a related run this process was not launched with', () => {
    const env = { [RUN_ARGS_ENV]: JSON.stringify(['related', 'src/a.ts']) }
    expect(selectsByImportGraph(env, ['node', 'vitest.mjs', 'run', 'src/b'])).toBe(false)
    expect(selectsByImportGraph({}, ['node', 'vitest.mjs', 'related', 'src/a.ts'])).toBe(false)
  })
})

describe('matchesRunFilter', () => {
  it('matches every file a Vitest substring or line filter selects', () => {
    const file = 'src/shared/worktree/Branch-Name.test.ts'
    expect(matchesRunFilter(file, ['src/shared/worktree'])).toBe(true)
    expect(matchesRunFilter(file, ['branch-name'])).toBe(true)
    expect(matchesRunFilter(file, [`${file}:12`])).toBe(true)
    expect(matchesRunFilter(file, [`${process.cwd()}/src/shared/`])).toBe(true)
    expect(matchesRunFilter(file, ['src/main'])).toBe(false)
  })
})
