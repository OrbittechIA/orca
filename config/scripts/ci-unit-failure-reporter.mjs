// Failures-only unit evidence for hosted runs whose console keeps only a tail; it never changes the test verdict.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const UNIT_FAILURE_REPORT_DIR_ENV = 'ORCA_UNIT_FAILURE_REPORT_DIR'
/** Every invocation's reports together stay within this, leaving the rest of a 16 MiB artifact. */
export const UNIT_FAILURE_REPORT_BUDGET_BYTES = 8 * 1024 * 1024
export const UNIT_FAILURE_REPORT_PREFIX = 'unit-failures-'
const TEXT_LIMIT_BYTES = 16 * 1024
// Room kept for the small records that must always be writable: a run's start and an over-budget marker.
const MARKER_RESERVE_BYTES = 64 * 1024

/** Cut at a code point boundary so a byte limit never splits a character. */
export function clipText(value, limitBytes = TEXT_LIMIT_BYTES) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (Buffer.byteLength(text) <= limitBytes) {
    return { text, truncated: false }
  }
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > limitBytes) {
      break
    }
    bytes += size
    end += character.length
  }
  return { text: text.slice(0, end), truncated: true }
}

function describeError(error, depth = 0) {
  const source = error !== null && typeof error === 'object' ? error : { message: String(error) }
  const message = clipText(source.message)
  const stack = clipText(source.stack ?? '')
  return {
    name: typeof source.name === 'string' ? source.name : null,
    message: message.text,
    stack: stack.text,
    truncated: message.truncated || stack.truncated,
    ...(source.cause !== undefined && depth < 3
      ? { cause: describeError(source.cause, depth + 1) }
      : {})
  }
}

const emptyCounts = () => ({ passed: 0, failed: 0, skipped: 0, pending: 0, queued: 0 })

/** Read states from tasks, not suite labels: a crashed worker leaves its suite unfinished, never passed. */
export function buildUnitFailureReport({ root, modules, unhandledErrors, reason, invocation }) {
  const file = (module) => relative(root, module.moduleId).replaceAll('\\', '/')
  const counts = { modules: emptyCounts(), tests: emptyCounts() }
  const unfinishedModules = []
  const failures = []
  const moduleErrors = []
  const suiteErrors = []
  for (const module of modules) {
    const state = module.state()
    counts.modules[state] = (counts.modules[state] ?? 0) + 1
    if (state === 'pending' || state === 'queued') {
      unfinishedModules.push(file(module))
    }
    const project = module.project?.name ?? null
    for (const error of module.errors()) {
      moduleErrors.push({ file: file(module), project, error: describeError(error) })
    }
    for (const suite of module.children.allSuites()) {
      for (const error of suite.errors()) {
        suiteErrors.push({
          file: file(module),
          project,
          suite: suite.fullName,
          error: describeError(error)
        })
      }
    }
    for (const test of module.children.allTests()) {
      const result = test.result()
      counts.tests[result.state] = (counts.tests[result.state] ?? 0) + 1
      if (result.state === 'failed') {
        failures.push({
          file: file(module),
          project,
          test: test.fullName,
          line: test.location?.line ?? null,
          errors: (result.errors ?? []).map((error) => describeError(error))
        })
      }
    }
  }
  const unhandled = unhandledErrors.map((error) => describeError(error))
  const clipped = (error) => error.truncated || (error.cause !== undefined && clipped(error.cause))
  return {
    metric: 'unit-failures-v1',
    invocation,
    status: reason,
    executionComplete:
      reason !== 'interrupted' && unfinishedModules.length === 0 && counts.tests.pending === 0,
    inventoryComplete: true,
    // Every entry is present, but a clipped message or stack is still not the whole evidence.
    truncated: [
      ...unhandled,
      ...moduleErrors.map((entry) => entry.error),
      ...suiteErrors.map((entry) => entry.error),
      ...failures.flatMap((entry) => entry.errors)
    ].some(clipped),
    counts: { ...counts, unhandledErrors: unhandledErrors.length },
    unfinishedModules,
    unhandledErrors: unhandled,
    moduleErrors,
    suiteErrors,
    failures
  }
}

const LIST_FIELDS = [
  'unhandledErrors',
  'moduleErrors',
  'suiteErrors',
  'failures',
  'unfinishedModules'
]

/** Keep whole entries in a fixed order until the limit; anything left out is counted and flagged. */
export function fitUnitFailureReport(report, limitBytes) {
  const serialized = JSON.stringify(report)
  if (Buffer.byteLength(serialized) <= limitBytes) {
    return serialized
  }
  const kept = { ...report, inventoryComplete: false, truncated: true, omitted: {} }
  for (const field of LIST_FIELDS) {
    kept[field] = []
    kept.omitted[field] = report[field].length
  }
  let size = Buffer.byteLength(JSON.stringify(kept))
  for (const field of LIST_FIELDS) {
    for (const entry of report[field]) {
      const entrySize = Buffer.byteLength(JSON.stringify(entry)) + 1
      if (size + entrySize > limitBytes) {
        break
      }
      kept[field].push(entry)
      kept.omitted[field] -= 1
      size += entrySize
    }
  }
  const fitted = JSON.stringify(kept)
  return Buffer.byteLength(fitted) <= limitBytes
    ? fitted
    : JSON.stringify(budgetMarker(report, 'budget-exhausted'))
}

function budgetMarker(report, cause) {
  return {
    metric: report.metric,
    invocation: report.invocation,
    status: report.status,
    executionComplete: report.executionComplete,
    inventoryComplete: false,
    truncated: true,
    cause,
    counts: report.counts
  }
}

/** Every report, start record and staged file of every invocation counts, read from disk each time. */
function reportBytes(directory) {
  let total = 0
  for (const name of readdirSync(directory)) {
    if (name.startsWith(UNIT_FAILURE_REPORT_PREFIX)) {
      total += statSync(join(directory, name), { throwIfNoEntry: false })?.size ?? 0
    }
  }
  return total
}

/** Publish by rename, so a reader never mistakes a half-written file for a report; a rename replaces an older one. */
function publish(directory, name, text) {
  const staged = join(directory, `${name}.partial`)
  writeFileSync(staged, text, { flag: 'wx' })
  renameSync(staged, join(directory, name))
}

export default class UnitFailureReporter {
  constructor(options = {}) {
    // An explicit directory, even none, wins over the environment so fixtures never write to a live report.
    this.directory =
      'directory' in options ? options.directory : process.env[UNIT_FAILURE_REPORT_DIR_ENV]
    this.budgetBytes = options.budgetBytes ?? UNIT_FAILURE_REPORT_BUDGET_BYTES
  }

  onInit(ctx) {
    this.ctx = ctx
  }

  onTestRunStart() {
    if (!this.directory) {
      return
    }
    // Several invocations may share the directory: each owns uniquely named files and never overwrites another's.
    this.id = `${UNIT_FAILURE_REPORT_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`
    this.invocation = {
      id: this.id,
      pid: process.pid,
      args: clipText(process.env.ORCA_VITEST_RUN_ARGS ?? JSON.stringify(process.argv.slice(2)))
        .text,
      vitestVersion: this.ctx?.version ?? null,
      nodeVersion: process.env.ORCA_TEST_NODE_VERSION ?? process.versions.node,
      ...(process.versions.bun ? { bunVersion: process.versions.bun } : {}),
      shard: this.ctx?.config?.shard ?? { index: 1, count: 1 },
      startedAt: new Date().toISOString()
    }
    // Left in place if the run never ends, so a killed invocation is visibly incomplete.
    this.write(`${this.id}.started.json`, () =>
      JSON.stringify({ metric: 'unit-failures-v1', invocation: this.invocation, started: true })
    )
  }

  onTestRunEnd(modules, unhandledErrors = [], reason) {
    if (!this.directory || !this.id) {
      return
    }
    const name = `${this.id}.json`
    try {
      const report = buildUnitFailureReport({
        root: this.ctx?.config?.root ?? process.cwd(),
        modules,
        unhandledErrors,
        reason,
        invocation: { ...this.invocation, endedAt: new Date().toISOString() }
      })
      if (
        !this.write(name, (limit) =>
          fitUnitFailureReport(report, Math.max(0, limit - MARKER_RESERVE_BYTES))
        )
      ) {
        return
      }
      this.remove(`${this.id}.started.json`)
      const total = reportBytes(this.directory)
      if (total > this.budgetBytes) {
        // A concurrent invocation spent the budget meanwhile: shrink to a marker if it fits, else withdraw.
        const own = statSync(join(this.directory, name), { throwIfNoEntry: false })?.size ?? 0
        const marker = JSON.stringify(budgetMarker(report, 'aggregate-budget-raced'))
        this.remove(name)
        if (total - own + Buffer.byteLength(marker) <= this.budgetBytes) {
          publish(this.directory, name, marker)
        } else {
          console.warn(`[unit-failures] ${name} withdrawn: the shared budget is spent`)
        }
      }
    } catch (error) {
      // Whatever was published stands; a report that is missing stays evident by its absence.
      console.warn(`[unit-failures] ${name} was not completed: ${String(error)}`)
    }
  }

  /** Publish only what fits in the bytes still free, so the shared budget is never exceeded. */
  write(name, render) {
    try {
      mkdirSync(this.directory, { recursive: true })
      const available = this.budgetBytes - reportBytes(this.directory)
      const text = render(available)
      const size = Buffer.byteLength(text)
      if (size > available) {
        console.warn(
          `[unit-failures] ${name} not written: needs ${size} bytes, ${Math.max(0, available)} free`
        )
        return false
      }
      publish(this.directory, name, text)
      return true
    } catch (error) {
      // Logged, not thrown: the failure report must never decide the test verdict.
      console.warn(`[unit-failures] ${name} was not written: ${String(error)}`)
      return false
    }
  }

  remove(name) {
    rmSync(join(this.directory, name), { force: true })
  }
}
