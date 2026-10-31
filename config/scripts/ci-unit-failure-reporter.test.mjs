import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import UnitFailureReporter, {
  clipText,
  UNIT_FAILURE_REPORT_BUDGET_BYTES,
  UNIT_FAILURE_REPORT_PREFIX
} from './ci-unit-failure-reporter.mjs'

const ROOT = '/repo'
const directories = []

const runArgs = process.env.ORCA_VITEST_RUN_ARGS

// Byte budgets below depend on record sizes, so the reporter must not echo this run's own arguments.
beforeEach(() => {
  process.env.ORCA_VITEST_RUN_ARGS = '["run"]'
})

afterEach(() => {
  if (runArgs === undefined) {
    delete process.env.ORCA_VITEST_RUN_ARGS
  } else {
    process.env.ORCA_VITEST_RUN_ARGS = runArgs
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function reportDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unit-failures-'))
  directories.push(directory)
  return directory
}

const testCase = (fullName, state, errors) => ({
  fullName,
  location: { line: 7 },
  result: () => ({ state, errors })
})

function testModule(file, { state = 'passed', errors = [], suites = [], tests = [] } = {}) {
  return {
    moduleId: `${ROOT}/${file}`,
    project: { name: 'node' },
    state: () => state,
    errors: () => errors,
    children: { allSuites: () => suites, allTests: () => tests }
  }
}

function run(directory, modules, unhandledErrors = [], reason = 'failed', budgetBytes) {
  const reporter = new UnitFailureReporter({ directory, budgetBytes })
  reporter.onInit({ version: '5.0.5', config: { root: ROOT } })
  reporter.onTestRunStart()
  reporter.onTestRunEnd(modules, unhandledErrors, reason)
}

// Another invocation's report already in the shared directory.
function earlierReport(directory, bytes) {
  writeFileSync(
    join(directory, `${UNIT_FAILURE_REPORT_PREFIX}earlier.json`),
    JSON.stringify({ filler: 'z'.repeat(bytes) })
  )
}

function directoryBytes(directory) {
  return readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0)
}

const failingModule = (file) =>
  testModule(file, { state: 'failed', tests: [testCase('fails', 'failed', [{ message: 'm' }])] })

function reports(directory) {
  return readdirSync(directory)
    .sort()
    .map((name) => ({ name, report: JSON.parse(readFileSync(join(directory, name), 'utf8')) }))
}

describe('unit failure evidence', () => {
  it('writes nothing and keeps no state when no directory is configured', () => {
    const reporter = new UnitFailureReporter({ directory: undefined })
    reporter.onInit({ config: { root: ROOT } })
    reporter.onTestRunStart()
    expect(() => reporter.onTestRunEnd([testModule('a.test.ts')], [], 'passed')).not.toThrow()
  })

  it('records a clean run as complete with no failures', () => {
    const directory = reportDirectory()
    run(
      directory,
      [testModule('a.test.ts', { tests: [testCase('works', 'passed')] })],
      [],
      'passed'
    )

    const [{ name, report }] = reports(directory)
    expect(name.startsWith(UNIT_FAILURE_REPORT_PREFIX)).toBe(true)
    expect(report).toMatchObject({
      status: 'passed',
      executionComplete: true,
      inventoryComplete: true,
      truncated: false,
      failures: [],
      counts: { tests: { passed: 1, failed: 0 }, unhandledErrors: 0 }
    })
  })

  it('keeps case, suite-hook and import failures by file', () => {
    const directory = reportDirectory()
    run(directory, [
      testModule('cases.test.ts', {
        state: 'failed',
        tests: [
          testCase('outer > keeps order', 'failed', [
            { name: 'AssertionError', message: 'expected 1' }
          ]),
          testCase('outer > other', 'passed')
        ],
        suites: [{ fullName: 'outer', errors: () => [{ message: 'beforeAll failed' }] }]
      }),
      testModule('broken-import.test.ts', {
        state: 'failed',
        errors: [{ name: 'SyntaxError', message: 'Unexpected token', stack: 'at broken.ts:1' }]
      })
    ])

    const [{ report }] = reports(directory)
    expect(report.failures).toEqual([
      {
        file: 'cases.test.ts',
        project: 'node',
        test: 'outer > keeps order',
        line: 7,
        errors: [{ name: 'AssertionError', message: 'expected 1', stack: '', truncated: false }]
      }
    ])
    expect(report.suiteErrors).toMatchObject([{ file: 'cases.test.ts', suite: 'outer' }])
    expect(report.moduleErrors).toMatchObject([
      { file: 'broken-import.test.ts', error: { name: 'SyntaxError', message: 'Unexpected token' } }
    ])
    expect(report.executionComplete).toBe(true)
  })

  it('marks a crashed worker run incomplete instead of trusting its suite labels', () => {
    const directory = reportDirectory()
    run(
      directory,
      [
        testModule('crashed.test.ts', {
          state: 'pending',
          tests: [testCase('never finished', 'pending'), testCase('finished first', 'passed')]
        })
      ],
      [
        {
          message: '[vitest-pool]: Worker node-runtime emitted error.',
          cause: { message: 'Worker exited unexpectedly with signal SIGABRT during started state' }
        }
      ]
    )

    const [{ report }] = reports(directory)
    expect(report).toMatchObject({
      executionComplete: false,
      unfinishedModules: ['crashed.test.ts'],
      counts: { tests: { pending: 1, passed: 1 }, unhandledErrors: 1 },
      unhandledErrors: [{ cause: { message: expect.stringContaining('SIGABRT') } }]
    })
  })

  it('marks an interrupted run incomplete', () => {
    const directory = reportDirectory()
    run(
      directory,
      [testModule('a.test.ts', { tests: [testCase('works', 'passed')] })],
      [],
      'interrupted'
    )

    expect(reports(directory)[0].report.executionComplete).toBe(false)
  })

  it('leaves the start record when a run never ends', () => {
    const directory = reportDirectory()
    const reporter = new UnitFailureReporter({ directory })
    reporter.onInit({ config: { root: ROOT } })
    reporter.onTestRunStart()

    const [{ name, report }] = reports(directory)
    expect(name.endsWith('.started.json')).toBe(true)
    expect(report).toMatchObject({ started: true })
  })

  it('clips text on a character boundary and says so', () => {
    expect(clipText('aé😀', 3)).toEqual({ text: 'aé', truncated: true })
    expect(clipText('aé😀', 7)).toEqual({ text: 'aé😀', truncated: false })
    const directory = reportDirectory()
    run(directory, [
      testModule('long.test.ts', {
        state: 'failed',
        tests: [testCase('long message', 'failed', [{ message: '😀'.repeat(10_000) }])]
      })
    ])

    const [{ report }] = reports(directory)
    expect(report).toMatchObject({ inventoryComplete: true, truncated: true })
    expect(Buffer.byteLength(report.failures[0].errors[0].message)).toBeLessThanOrEqual(16 * 1024)
    expect(report.failures[0].errors[0].message.endsWith('😀')).toBe(true)
  })

  it('drops whole entries past the budget and counts what it left out', () => {
    const directory = reportDirectory()
    const tests = Array.from({ length: 400 }, (_, index) =>
      testCase(`case ${index}`, 'failed', [{ message: 'x'.repeat(2000) }])
    )
    run(
      directory,
      [testModule('many.test.ts', { state: 'failed', tests })],
      [],
      'failed',
      400 * 1024
    )

    const [{ name, report }] = reports(directory)
    expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(400 * 1024)
    expect(report).toMatchObject({ inventoryComplete: false, truncated: true })
    expect(report.failures.length + report.omitted.failures).toBe(400)
    expect(report.omitted.failures).toBeGreaterThan(0)
    expect(report.counts.tests.failed).toBe(400)
  })

  it('gives each invocation its own report inside one shared budget', () => {
    const directory = reportDirectory()
    const failing = (file) =>
      testModule(file, {
        state: 'failed',
        tests: [testCase('fails', 'failed', [{ message: 'y'.repeat(4000) }])]
      })
    earlierReport(directory, 200 * 1024)
    run(directory, [failing('related.test.ts')], [], 'failed', 300 * 1024)
    run(directory, [failing('colocated.test.ts')], [], 'failed', 300 * 1024)

    const written = reports(directory).filter(({ name }) => !name.endsWith('earlier.json'))
    expect(written).toHaveLength(2)
    expect(new Set(written.map(({ report }) => report.invocation.id)).size).toBe(2)
    expect(written.map(({ report }) => report.failures[0]?.file ?? null).sort()).toEqual([
      'colocated.test.ts',
      'related.test.ts'
    ])
    expect(directoryBytes(directory)).toBeLessThanOrEqual(300 * 1024)
  })

  it('writes an over-budget marker into the little room another invocation left', () => {
    const directory = reportDirectory()
    earlierReport(directory, 62 * 1024)
    run(directory, [failingModule('a.test.ts')], [], 'failed', 64 * 1024)

    const marker = reports(directory).find(({ name }) => !name.endsWith('earlier.json'))
    expect(marker?.name.endsWith('.started.json')).toBe(false)
    expect(marker?.report).toMatchObject({
      inventoryComplete: false,
      truncated: true,
      counts: { tests: { failed: 1 } }
    })
    expect(directoryBytes(directory)).toBeLessThanOrEqual(64 * 1024)
  })

  it('adds nothing to a budget another invocation already filled, the default one included', () => {
    for (const budgetBytes of [64 * 1024, UNIT_FAILURE_REPORT_BUDGET_BYTES]) {
      const directory = reportDirectory()
      earlierReport(directory, budgetBytes - JSON.stringify({ filler: '' }).length)
      expect(directoryBytes(directory)).toBe(budgetBytes)
      run(directory, [failingModule('a.test.ts')], [], 'failed', budgetBytes)

      expect(directoryBytes(directory)).toBe(budgetBytes)
      expect(readdirSync(directory)).toEqual([`${UNIT_FAILURE_REPORT_PREFIX}earlier.json`])
    }
  })

  it('keeps the start record when only it fits, so the missing report stays evident', () => {
    const measure = reportDirectory()
    const probe = new UnitFailureReporter({ directory: measure })
    probe.onInit({ config: { root: ROOT } })
    probe.onTestRunStart()
    const startBytes = directoryBytes(measure)

    const directory = reportDirectory()
    const budgetBytes = 64 * 1024
    earlierReport(directory, budgetBytes - startBytes - 64)
    run(directory, [failingModule('a.test.ts')], [], 'failed', budgetBytes)

    const own = readdirSync(directory).filter((name) => !name.endsWith('earlier.json'))
    expect(own).toHaveLength(1)
    expect(own[0].endsWith('.started.json')).toBe(true)
    expect(directoryBytes(directory)).toBeLessThanOrEqual(budgetBytes)
  })

  it('lets interleaved invocations share the budget without touching each other', () => {
    const directory = reportDirectory()
    const budgetBytes = 200 * 1024
    const [first, second] = [0, 1].map(() => {
      const reporter = new UnitFailureReporter({ directory, budgetBytes })
      reporter.onInit({ config: { root: ROOT } })
      reporter.onTestRunStart()
      return reporter
    })
    const tests = Array.from({ length: 100 }, (_, index) =>
      testCase(`case ${index}`, 'failed', [{ message: 'x'.repeat(2000) }])
    )
    first.onTestRunEnd([testModule('first.test.ts', { state: 'failed', tests })], [], 'failed')
    const firstName = `${first.id}.json`
    const firstText = readFileSync(join(directory, firstName), 'utf8')
    second.onTestRunEnd([failingModule('second.test.ts')], [], 'failed')

    expect(readFileSync(join(directory, firstName), 'utf8')).toBe(firstText)
    expect(JSON.parse(firstText)).toMatchObject({ inventoryComplete: false, truncated: true })
    expect(
      reports(directory)
        .map(({ name }) => name)
        .sort()
    ).toEqual([firstName, `${second.id}.json`].sort())
    expect(directoryBytes(directory)).toBeLessThanOrEqual(budgetBytes)
  })

  it('keeps the default budget within half of a 16 MiB artifact', () => {
    expect(UNIT_FAILURE_REPORT_BUDGET_BYTES).toBe(8 * 1024 * 1024)
  })

  it('never throws into the run when the directory cannot be written', () => {
    const directory = reportDirectory()
    const blocked = join(directory, 'not-a-directory')
    writeFileSync(blocked, '')
    expect(() =>
      run(
        blocked,
        [testModule('a.test.ts', { tests: [testCase('works', 'passed')] })],
        [],
        'passed'
      )
    ).not.toThrow()
  })
})
