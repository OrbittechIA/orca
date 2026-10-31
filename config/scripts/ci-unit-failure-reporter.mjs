// Bounded unit evidence for hosted runs whose console keeps only a tail; it never changes the test verdict.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VALUE_OPTIONS } from './vitest-run-filters.mjs'

export const UNIT_FAILURE_REPORT_DIR_ENV = 'ORCA_UNIT_FAILURE_REPORT_DIR'
/** Every invocation's reports together stay within this, leaving the rest of a 16 MiB artifact. */
export const UNIT_FAILURE_REPORT_BUDGET_BYTES = 8 * 1024 * 1024
export const UNIT_FAILURE_REPORT_PREFIX = 'unit-failures-'
const TEXT_LIMIT_BYTES = 16 * 1024
// Room kept for the small records that must always be writable: a run's start and an over-budget marker.
const MARKER_RESERVE_BYTES = 64 * 1024
const PROGRESS_INTERVAL_MS = 5_000
const FAILURE_CHECKPOINT_INTERVAL_MS = 250

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

const VITEST_COMMANDS = new Set(['run', 'related', 'watch', 'dev', 'bench', 'list', 'typecheck'])

function parseArgList(text) {
  try {
    const value = JSON.parse(text)
    return Array.isArray(value) && value.every((arg) => typeof arg === 'string') ? value : null
  } catch {
    return null
  }
}

/** Inputs after the command, skipping option values; everything after `--` is an input. */
function countInputs(args, start) {
  let count = 0
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      return count + args.length - index - 1
    }
    if (!arg.startsWith('-')) {
      count += 1
    } else if (!arg.includes('=') && VALUE_OPTIONS.has(arg)) {
      index += 1
    }
  }
  return count
}

/** A clipped args prefix is not the invocation; identify the whole one by kind, counts and digest. */
export function describeInvocationArgs(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const clipped = clipText(text)
  const args = parseArgList(text)
  const command = args && VITEST_COMMANDS.has(args[0]) ? args[0] : null
  return {
    args: clipped.text,
    argsTruncated: clipped.truncated,
    argsBytes: Buffer.byteLength(text),
    argsSha256: createHash('sha256').update(text).digest('hex'),
    argsKind: args ? (command ?? 'default') : 'unparsed',
    argCount: args ? args.length : null,
    inputCount: args ? countInputs(args, command ? 1 : 0) : null
  }
}

function describeError(error, depth = 0) {
  const source = error !== null && typeof error === 'object' ? error : { message: String(error) }
  const name = typeof source.name === 'string' ? clipText(source.name) : null
  const message = clipText(source.message)
  const stack = clipText(source.stack ?? '')
  return {
    name: name?.text ?? null,
    message: message.text,
    stack: stack.text,
    truncated: !!name?.truncated || message.truncated || stack.truncated,
    ...(source.cause !== undefined && depth < 3
      ? { cause: describeError(source.cause, depth + 1) }
      : {})
  }
}

const emptyCounts = () => ({ passed: 0, failed: 0, skipped: 0, pending: 0, queued: 0 })

/** Read states from tasks, not suite labels: a crashed worker leaves its suite unfinished, never passed. */
export function buildUnitFailureReport({
  root,
  modules,
  unhandledErrors,
  reason,
  invocation,
  diagnosticBudgetBytes = Infinity
}) {
  const file = (module) => relative(root, module.moduleId).replaceAll('\\', '/')
  const counts = { modules: emptyCounts(), tests: emptyCounts() }
  const unfinishedModules = []
  const moduleInventory = []
  const failures = []
  const moduleErrors = []
  const suiteErrors = []
  const unhandled = []
  const lists = { failures, moduleErrors, suiteErrors, unhandledErrors: unhandled }
  const omitted = {
    failures: 0,
    moduleErrors: 0,
    suiteErrors: 0,
    unhandledErrors: 0,
    moduleInventory: 0
  }
  let diagnosticBytes = 0
  const append = (field, create) => {
    if (diagnosticBytes >= diagnosticBudgetBytes) {
      omitted[field] += 1
      return
    }
    const entry = create()
    if (Number.isFinite(diagnosticBudgetBytes)) {
      diagnosticBytes += Buffer.byteLength(JSON.stringify(entry))
    }
    if (diagnosticBytes > diagnosticBudgetBytes) {
      omitted[field] += 1
    } else {
      lists[field].push(entry)
    }
  }
  for (const error of unhandledErrors) {
    append('unhandledErrors', () => describeError(error))
  }
  for (const module of modules) {
    const state = module.state()
    counts.modules[state] = (counts.modules[state] ?? 0) + 1
    if (state === 'pending' || state === 'queued') {
      unfinishedModules.push(file(module))
    }
    const project = module.project?.name ?? null
    const moduleTests = emptyCounts()
    for (const error of module.errors()) {
      append('moduleErrors', () => ({ file: file(module), project, error: describeError(error) }))
    }
    for (const suite of module.children.allSuites()) {
      for (const error of suite.errors()) {
        append('suiteErrors', () => ({
          file: file(module),
          project,
          suite:
            Number.isFinite(diagnosticBudgetBytes) ? clipText(suite.fullName).text : suite.fullName,
          error: describeError(error)
        }))
      }
    }
    for (const test of module.children.allTests()) {
      const result = test.result()
      counts.tests[result.state] = (counts.tests[result.state] ?? 0) + 1
      moduleTests[result.state] = (moduleTests[result.state] ?? 0) + 1
      if (result.state === 'failed') {
        append('failures', () => {
          const failure = {
            file: file(module),
            project,
            test:
              Number.isFinite(diagnosticBudgetBytes) ? clipText(test.fullName).text : test.fullName,
            line: test.location?.line ?? null,
            errors: []
          }
          if (!Number.isFinite(diagnosticBudgetBytes)) {
            return {
              ...failure,
              errors: (result.errors ?? []).map((error) => describeError(error))
            }
          }
          let bytes = Buffer.byteLength(JSON.stringify(failure))
          for (const error of result.errors ?? []) {
            const described = describeError(error)
            bytes += Buffer.byteLength(JSON.stringify(described)) + 1
            if (diagnosticBytes + bytes > diagnosticBudgetBytes) {
              failure.errorsOmitted = (result.errors ?? []).length - failure.errors.length
              break
            }
            failure.errors.push(described)
          }
          return failure
        })
      }
    }
    if (Number.isFinite(diagnosticBudgetBytes)) {
      omitted.moduleInventory += 1
    } else {
      moduleInventory.push({ file: file(module), project, state, tests: moduleTests })
    }
  }
  const clipped = (error) => error.truncated || (error.cause !== undefined && clipped(error.cause))
  return {
    metric: 'unit-failures-v1',
    invocation,
    status: reason,
    executionComplete:
      (reason === 'passed' || reason === 'failed') &&
      unfinishedModules.length === 0 &&
      counts.tests.pending === 0 &&
      counts.tests.queued === 0,
    inventoryComplete: !Number.isFinite(diagnosticBudgetBytes),
    // Missing entries and clipped diagnostics both make the evidence incomplete.
    truncated:
      Object.values(omitted).some(Boolean) ||
      failures.some((failure) => failure.errorsOmitted) ||
      [
        ...unhandled,
        ...moduleErrors.map((entry) => entry.error),
        ...suiteErrors.map((entry) => entry.error),
        ...failures.flatMap((entry) => entry.errors)
      ].some(clipped),
    counts: { ...counts, unhandledErrors: unhandledErrors.length },
    ...(Number.isFinite(diagnosticBudgetBytes) ? { omitted } : {}),
    unfinishedModules,
    moduleInventory,
    unhandledErrors: unhandled,
    moduleErrors,
    suiteErrors,
    failures
  }
}

const LIST_FIELDS = [
  'activeModules',
  'activeTasks',
  'unhandledErrors',
  'moduleErrors',
  'suiteErrors',
  'failures',
  'unfinishedModules',
  'moduleInventory'
]

/** Keep whole entries in a fixed order until the limit; anything left out is counted and flagged. */
export function fitUnitFailureReport(report, limitBytes) {
  if (!report.snapshotOnly) {
    const serialized = JSON.stringify(report)
    if (Buffer.byteLength(serialized) <= limitBytes) {
      return serialized
    }
  }
  const kept = {
    ...report,
    inventoryComplete: false,
    truncated: true,
    omitted: { ...report.omitted }
  }
  const fields = LIST_FIELDS.filter((field) => Array.isArray(report[field]))
  for (const field of fields) {
    kept[field] = []
    kept.omitted[field] = (report.omitted?.[field] ?? 0) + report[field].length
  }
  let size = Buffer.byteLength(JSON.stringify(kept))
  for (const field of fields) {
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

  onTestRunStart(specifications = []) {
    if (!this.directory) {
      return
    }
    // Several invocations may share the directory: each owns uniquely named files and never overwrites another's.
    this.id = `${UNIT_FAILURE_REPORT_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}`
    this.invocation = {
      id: this.id,
      pid: process.pid,
      ...describeInvocationArgs(
        process.env.ORCA_VITEST_RUN_ARGS ?? JSON.stringify(process.argv.slice(2))
      ),
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
    this.modules = new Map()
    this.activeModules = new Map()
    this.activeTasks = new Map()
    this.plannedModules = specifications.length
    this.unhandledCount = 0
    this.lastCheckpointAt = undefined
    this.dirty = true
    this.progressTimer = setInterval(() => this.checkpoint(), PROGRESS_INTERVAL_MS)
    this.progressTimer.unref()
  }

  moduleActivity(module, phase) {
    if (!this.modules) {
      return
    }
    this.modules.set(module.id, module)
    const now = new Date().toISOString()
    const root = this.ctx?.config?.root ?? process.cwd()
    this.activeModules.set(module.id, {
      file: relative(root, module.moduleId).replaceAll('\\', '/'),
      project: module.project?.name ?? null,
      phase,
      startedAt: this.activeModules.get(module.id)?.startedAt ?? now,
      updatedAt: now
    })
    this.dirty = true
  }

  onTestModuleQueued(module) {
    this.moduleActivity(module, 'loading')
  }

  onTestModuleCollected(module) {
    this.moduleActivity(module, 'collected')
  }

  onTestModuleStart(module) {
    this.moduleActivity(module, 'running')
  }

  taskActivity(entity, hook) {
    if (!this.modules) {
      return
    }
    const module = entity.module ?? entity
    const name = clipText(entity.fullName ?? module.moduleId)
    this.moduleActivity(module, 'running')
    this.activeTasks.set(`${hook ? 'hook' : 'task'}:${entity.id}`, {
      moduleId: module.id,
      file: this.activeModules.get(module.id).file,
      project: module.project?.name ?? null,
      type: hook ? 'hook' : entity.type,
      name: name.text,
      nameTruncated: name.truncated,
      ...(hook ? { hook } : {}),
      startedAt: new Date().toISOString()
    })
  }

  onTestCaseReady(test) {
    this.taskActivity(test)
  }

  onTestCaseResult(test) {
    this.activeTasks?.delete(`task:${test.id}`)
    this.dirty = true
    if (test.result().state === 'failed') {
      this.failureCheckpoint()
    }
  }

  onTestSuiteReady(suite) {
    this.taskActivity(suite)
  }

  onTestSuiteResult(suite) {
    this.activeTasks?.delete(`task:${suite.id}`)
    this.dirty = true
    if (suite.errors().length > 0) {
      this.failureCheckpoint()
    }
  }

  onHookStart({ entity, name }) {
    this.taskActivity(entity, name)
  }

  onHookEnd({ entity }) {
    this.activeTasks?.delete(`hook:${entity.id}`)
    this.dirty = true
  }

  onTestModuleEnd(module) {
    if (!this.modules) {
      return
    }
    this.modules.set(module.id, module)
    this.activeModules.delete(module.id)
    for (const [key, task] of this.activeTasks) {
      if (task.moduleId === module.id) {
        this.activeTasks.delete(key)
      }
    }
    this.dirty = true
    if (module.state() === 'failed' || module.errors().length > 0) {
      this.failureCheckpoint()
    }
  }

  failureCheckpoint() {
    if (!this.modules || this.failureTimer) {
      return
    }
    const delay = Math.min(
      FAILURE_CHECKPOINT_INTERVAL_MS,
      Math.max(0, FAILURE_CHECKPOINT_INTERVAL_MS - (Date.now() - (this.lastCheckpointAt ?? -Infinity)))
    )
    if (delay === 0) {
      this.checkpoint()
      return
    }
    // One trailing timer coalesces bursts; a forced stop can lose the last interval's observations.
    this.failureTimer = setTimeout(() => {
      this.failureTimer = undefined
      this.checkpoint()
    }, delay)
    this.failureTimer.unref()
  }

  checkpoint() {
    if (!this.modules) {
      return
    }
    try {
      const unhandledErrors = this.ctx?.state?.getUnhandledErrors() ?? []
      if (!this.dirty && unhandledErrors.length === this.unhandledCount) {
        return
      }
      clearTimeout(this.failureTimer)
      this.failureTimer = undefined
      this.dirty = false
      this.unhandledCount = unhandledErrors.length
      const diagnosticBudgetBytes = Math.floor(this.budgetBytes / 3)
      const report = {
        ...buildUnitFailureReport({
          root: this.ctx?.config?.root ?? process.cwd(),
          modules: [...this.modules.values()],
          unhandledErrors,
          reason: 'running',
          invocation: this.invocation,
          diagnosticBudgetBytes
        }),
        inventoryComplete: false,
        snapshotOnly: true,
        observedAt: new Date().toISOString(),
        plannedModules: this.plannedModules,
        activeModules: [...this.activeModules.values()],
        activeTasks: [...this.activeTasks.values()]
      }
      report.truncated ||= report.activeTasks.some((task) => task.nameTruncated)
      // Leave room for both the previous atomic snapshot and the final report.
      this.write(`${this.id}.progress.json`, (limit) =>
        fitUnitFailureReport(
          report,
          Math.max(0, Math.min(diagnosticBudgetBytes, limit - MARKER_RESERVE_BYTES))
        )
      )
    } catch (error) {
      console.warn(`[unit-failures] progress was not written: ${String(error)}`)
    }
    this.lastCheckpointAt = Date.now()
  }

  onTestRunEnd(modules, unhandledErrors = [], reason) {
    clearInterval(this.progressTimer)
    clearTimeout(this.failureTimer)
    this.failureTimer = undefined
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
      this.remove(`${this.id}.progress.json`)
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
