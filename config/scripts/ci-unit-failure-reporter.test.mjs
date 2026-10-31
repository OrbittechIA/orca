import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UnitFailureReporter, {
  clipText,
  describeInvocationArgs,
  UNIT_FAILURE_REPORT_BUDGET_BYTES,
  UNIT_FAILURE_REPORT_PREFIX
} from './ci-unit-failure-reporter.mjs'

const ROOT = '/repo'
const directories = []

const runArgs = process.env.ORCA_VITEST_RUN_ARGS

// Byte budgets below depend on record sizes, so the reporter must not echo this run's own arguments.
beforeEach(() => {
  vi.useFakeTimers()
  process.env.ORCA_VITEST_RUN_ARGS = '["run"]'
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
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
    id: `node:${file}`,
    type: 'module',
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

function progressReport(directory, reporter) {
  return JSON.parse(readFileSync(join(directory, `${reporter.id}.progress.json`), 'utf8'))
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

  it('coalesces failure bursts, retains case and hook observations, and retires the final timer', () => {
    const directory = reportDirectory()
    const reporter = new UnitFailureReporter({ directory })
    const unhandled = []
    reporter.onInit({ config: { root: ROOT }, state: { getUnhandledErrors: () => unhandled } })
    reporter.onTestRunStart([{}, {}, {}, {}])
    const publications = vi.spyOn(reporter, 'write')
    const failed = failingModule('cases.test.ts')
    const tests = failed.children.allTests()
    const [test] = tests
    Object.assign(test, { id: 'case-1', type: 'test', module: failed })
    reporter.onTestModuleQueued(failed)
    reporter.onTestCaseReady(test)
    reporter.onTestCaseResult(test)
    expect(progressReport(directory, reporter).failures).toMatchObject([
      { file: 'cases.test.ts', test: 'fails' }
    ])
    const firstObservation = progressReport(directory, reporter).observedAt
    for (let index = 1; index < 200; index += 1) {
      const next = testCase(`failure ${index}`, 'failed', [{ message: `assertion ${index}` }])
      Object.assign(next, { id: `case-${index + 1}`, type: 'test', module: failed })
      tests.push(next)
      reporter.onTestCaseReady(next)
      reporter.onTestCaseResult(next)
    }
    reporter.onTestModuleEnd(failed)
    const broken = testModule('import.test.ts', {
      state: 'failed',
      errors: [{ message: 'import failed' }]
    })
    reporter.onTestModuleQueued(broken)
    reporter.onTestModuleEnd(broken)
    const suite = { id: 'suite-1', type: 'suite', fullName: 'outer', errors: () => [] }
    const stuck = testModule('stuck.test.ts', { state: 'pending', suites: [suite] })
    suite.module = stuck
    reporter.onTestModuleQueued(stuck)
    reporter.onTestModuleCollected(stuck)
    reporter.onTestModuleStart(stuck)
    reporter.onTestSuiteReady(suite)
    reporter.onHookStart({ entity: suite, name: 'beforeAll' })
    unhandled.push({ message: 'worker exited unexpectedly' })
    expect(publications).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(2)
    vi.advanceTimersByTime(249)
    expect(publications).toHaveBeenCalledTimes(1)
    expect(progressReport(directory, reporter).observedAt).toBe(firstObservation)
    vi.advanceTimersByTime(1)
    expect(publications).toHaveBeenCalledTimes(2)

    const progress = progressReport(directory, reporter)
    expect(progress).toMatchObject({
      status: 'running',
      executionComplete: false,
      inventoryComplete: false,
      snapshotOnly: true,
      plannedModules: 4,
      failures: tests.map((entry) => ({ file: 'cases.test.ts', test: entry.fullName })),
      counts: { tests: { failed: 200 } },
      moduleErrors: [{ file: 'import.test.ts', error: { message: 'import failed' } }],
      unhandledErrors: [{ message: 'worker exited unexpectedly' }],
      activeModules: [{ file: 'stuck.test.ts', phase: 'running' }],
      activeTasks: [
        { file: 'stuck.test.ts', type: 'suite', name: 'outer' },
        { file: 'stuck.test.ts', type: 'hook', name: 'outer', hook: 'beforeAll' }
      ]
    })
    expect(progress.observedAt).not.toBe(firstObservation)
    expect(readdirSync(directory)).toHaveLength(2)
    reporter.onHookEnd({ entity: suite })
    suite.errors = () => [{ message: 'beforeAll failed' }]
    reporter.onTestSuiteResult(suite)
    expect(publications).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(250)
    expect(publications).toHaveBeenCalledTimes(3)
    const afterHook = progressReport(directory, reporter)
    expect(afterHook.suiteErrors).toMatchObject([{ file: 'stuck.test.ts', suite: 'outer' }])
    expect(afterHook.activeTasks).toEqual([])
    const last = testCase('last failure', 'failed', [{ message: 'last assertion' }])
    Object.assign(last, { id: 'last-case', type: 'test', module: failed })
    tests.push(last)
    reporter.onTestCaseResult(last)
    expect(vi.getTimerCount()).toBe(2)
    reporter.onTestRunEnd([failed, broken, stuck], unhandled, 'failed')
    expect(publications).toHaveBeenCalledTimes(4)
    expect(publications.mock.results.every(({ value }) => value === true)).toBe(true)
    const [{ name, report }] = reports(directory)
    expect(name).toBe(`${reporter.id}.json`)
    expect(report).toMatchObject({
      status: 'failed',
      executionComplete: false,
      inventoryComplete: true,
      counts: { tests: { failed: 201 } },
      suiteErrors: [{ suite: 'outer', error: { message: 'beforeAll failed' } }]
    })
    expect(report.failures.at(-1)).toMatchObject({ test: 'last failure' })
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(publications).toHaveBeenCalledTimes(4)
    expect(reports(directory)).toHaveLength(1)
  })

  it('replaces bounded progress snapshots and supersedes them only after publishing the final report', () => {
    const directory = reportDirectory()
    const budgetBytes = 256 * 1024
    const reporter = new UnitFailureReporter({ directory, budgetBytes })
    const unhandledErrors = [{ message: 'worker exited unexpectedly' }]
    reporter.onInit({ config: { root: ROOT }, state: { getUnhandledErrors: () => unhandledErrors } })
    reporter.onTestRunStart([{}])
    const module = testModule('large.test.ts', {
      state: 'failed',
      tests: Array.from({ length: 200 }, (_, index) =>
        testCase(`case ${index}`, 'failed', [{ message: 'x'.repeat(2000) }])
      )
    })
    reporter.onTestModuleQueued(module)
    reporter.onTestModuleStart(module)
    vi.advanceTimersByTime(5_000)
    const progress = progressReport(directory, reporter)
    expect(progress).toMatchObject({
      executionComplete: false,
      truncated: true,
      counts: { tests: { failed: 200 }, unhandledErrors: 1 },
      unhandledErrors: [{ message: 'worker exited unexpectedly' }]
    })
    expect(progress.failures.length + progress.omitted.failures).toBe(200)
    expect(progress.omitted.moduleInventory).toBe(1)
    expect(progress.activeModules).toMatchObject([{ file: 'large.test.ts', phase: 'running' }])
    expect(statSync(join(directory, `${reporter.id}.progress.json`)).size).toBeLessThanOrEqual(
      Math.floor(budgetBytes / 3)
    )
    expect(directoryBytes(directory)).toBeLessThanOrEqual(budgetBytes)
    reporter.onTestModuleEnd(module)
    reporter.onTestRunEnd([module], unhandledErrors, 'failed')
    expect(reports(directory)).toHaveLength(1)
    expect(reports(directory)[0]).toMatchObject({
      name: `${reporter.id}.json`,
      report: { status: 'failed', executionComplete: true }
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(directoryBytes(directory)).toBeLessThanOrEqual(budgetBytes)
  })

  it('records each executed file and project without substituting aggregate test counts', () => {
    const directory = reportDirectory()
    const secondProject = testModule('a.test.ts', {
      tests: [testCase('another runtime', 'passed')]
    })
    secondProject.project.name = 'bun'
    run(directory, [
      testModule('a.test.ts', {
        tests: [testCase('works', 'passed'), testCase('not executed', 'skipped')]
      }),
      secondProject,
      testModule('b.test.ts', { state: 'failed', tests: [testCase('fails', 'failed')] })
    ])

    const [{ report }] = reports(directory)
    expect(report.moduleInventory).toEqual([
      {
        file: 'a.test.ts',
        project: 'node',
        state: 'passed',
        tests: { passed: 1, failed: 0, skipped: 1, pending: 0, queued: 0 }
      },
      {
        file: 'a.test.ts',
        project: 'bun',
        state: 'passed',
        tests: { passed: 1, failed: 0, skipped: 0, pending: 0, queued: 0 }
      },
      {
        file: 'b.test.ts',
        project: 'node',
        state: 'failed',
        tests: { passed: 0, failed: 1, skipped: 0, pending: 0, queued: 0 }
      }
    ])
    expect(report.counts.tests).toEqual({ passed: 2, failed: 1, skipped: 1, pending: 0, queued: 0 })
  })

  it('keeps queued assertions incomplete even when their module already says passed', () => {
    const directory = reportDirectory()
    run(
      directory,
      [testModule('a.test.ts', { tests: [testCase('not started', 'queued')] })],
      [],
      'passed'
    )

    const [{ report }] = reports(directory)
    expect(report.executionComplete).toBe(false)
    expect(report.moduleInventory[0].tests.queued).toBe(1)
  })

  it('counts omitted module identities when successful runs exceed the shared evidence budget', () => {
    const directory = reportDirectory()
    const modules = Array.from({ length: 1000 }, (_, index) =>
      testModule(`long-${index}-${'x'.repeat(100)}.test.ts`, {
        tests: [testCase('works', 'passed')]
      })
    )
    run(directory, modules, [], 'passed', 256 * 1024)

    const [{ report }] = reports(directory)
    expect(directoryBytes(directory)).toBeLessThanOrEqual(256 * 1024)
    expect(report.inventoryComplete).toBe(false)
    expect(report.truncated).toBe(true)
    expect(report.moduleInventory.length + report.omitted.moduleInventory).toBe(1000)
    expect(report.omitted.moduleInventory).toBeGreaterThan(0)
    expect(report.counts.tests.passed).toBe(1000)
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

  // The hosted related run named 275 plan files, past the 16 KiB args clip.
  const relatedArgs = [
    'related',
    '--run',
    '--maxWorkers',
    '2',
    ...Array.from(
      { length: 275 },
      (_, index) => `src/main/runtime/rpc/methods/orchestration/worker/plan-input-${index}.test.ts`
    )
  ]
  const sha256 = (text) => createHash('sha256').update(text).digest('hex')

  it('identifies a related run past the args clip by kind, counts and digest', () => {
    const raw = JSON.stringify(relatedArgs)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(16 * 1024)
    process.env.ORCA_VITEST_RUN_ARGS = raw
    const directory = reportDirectory()
    run(directory, [failingModule('related.test.ts')], [], 'failed')

    const [{ report }] = reports(directory)
    const { invocation } = report
    expect(invocation).toMatchObject({
      argsTruncated: true,
      argsBytes: Buffer.byteLength(raw),
      argsSha256: sha256(raw),
      argsKind: 'related',
      argCount: 279,
      inputCount: 275
    })
    expect(Buffer.byteLength(invocation.args)).toBeLessThanOrEqual(16 * 1024)
    expect(raw.startsWith(invocation.args)).toBe(true)
    // The kept prefix is not a whole invocation, so a reader cannot take it for one.
    expect(() => JSON.parse(invocation.args)).toThrow()
    // Clipping the identity never softens the verdict the run itself reported.
    expect(report).toMatchObject({ status: 'failed', counts: { tests: { failed: 1 } } })
    expect(report.failures).toHaveLength(1)
  })

  it('keeps an interrupted long related run incomplete', () => {
    process.env.ORCA_VITEST_RUN_ARGS = JSON.stringify(relatedArgs)
    const directory = reportDirectory()
    run(
      directory,
      [testModule('unfinished.test.ts', { state: 'pending', tests: [testCase('t', 'pending')] })],
      [],
      'interrupted'
    )

    const [{ report }] = reports(directory)
    expect(report.invocation.argsTruncated).toBe(true)
    expect(report).toMatchObject({
      status: 'interrupted',
      executionComplete: false,
      unfinishedModules: ['unfinished.test.ts']
    })
  })

  it('keeps short args whole and marks only unreadable args as unparsed', () => {
    const short = JSON.stringify(['run', '--project', 'node', 'a.test.ts', '--', '-b.test.ts'])
    expect(describeInvocationArgs(short)).toEqual({
      args: short,
      argsTruncated: false,
      argsBytes: Buffer.byteLength(short),
      argsSha256: sha256(short),
      argsKind: 'run',
      argCount: 6,
      inputCount: 2
    })
    expect(describeInvocationArgs('["a.test.ts","--shard=1/2"]')).toMatchObject({
      argsKind: 'default',
      inputCount: 1
    })
    expect(describeInvocationArgs('related --run a.test.ts')).toMatchObject({
      argsTruncated: false,
      argsKind: 'unparsed',
      argCount: null,
      inputCount: null
    })
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
