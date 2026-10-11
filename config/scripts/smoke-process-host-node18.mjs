import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  readLegacyProcessHostStage,
  stageDirectoryFromArgs
} from './legacy-process-host-node18-staging.mjs'

const require = createRequire(import.meta.url)

async function awaitChildClose(closed) {
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned smoke child did not close within 5 seconds')),
          5_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function smokeLegacyProcessHost(directory) {
  const { output } = await readLegacyProcessHostStage(directory)
  const runtime = require(output)
  const imported = await import(pathToFileURL(output).href)
  assert.equal(imported.default, runtime, 'require/import must share one staged module')
  for (const name of [
    'runProcessSync',
    'runProcess',
    'setSpawnObserver',
    'setProcessTreeKillGate'
  ]) {
    assert.equal(imported.default[name], runtime[name])
  }
  const home = await mkdtemp(path.join(tmpdir(), 'orca-legacy-node18-smoke-'))
  const env = {
    ...Object.fromEntries(
      ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'TMP', 'TEMP']
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    ),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    NODE_PATH: '',
    NODE_OPTIONS: '',
    ORCA_BACKGROUND_LAUNCH: '1'
  }
  const observed = []
  const gateCalls = []
  let child, closed, watchdog, cancelTimer
  const command = (fixture, extra = {}, args = []) => ({
    program: process.execPath,
    args: [path.join(home, fixture), ...args],
    cwd: home,
    env,
    timeoutMs: 2_000,
    detached: true,
    ...extra
  })
  const assertReaped = (result) => {
    assert.match(result.stdout, /^\d+$/)
    const pid = Number(result.stdout)
    assert.throws(
      () => process.kill(pid, 0),
      { code: 'ESRCH' },
      `Owned child ${pid} was not reaped`
    )
  }
  try {
    await writeFile(path.join(home, 'output.cjs'), 'process.stdout.write(process.argv[2])\n')
    await writeFile(
      path.join(home, 'idle.cjs'),
      [
        'process.stdout.write(String(process.pid))',
        'setInterval(() => {}, 1000)',
        'setTimeout(() => process.exit(0), 10000)'
      ].join('\n')
    )
    const sync = runtime.runProcessSync(command('output.cjs', {}, ['staged-sync']))
    assert.equal(sync.code, 0)
    assert.equal(sync.stdout, 'staged-sync')
    assert.equal(sync.timedOut, false)
    imported.default.setSpawnObserver((program) => observed.push(program))
    assert.equal(runtime.hasSpawnObserver(), true)
    const asyncResult = await runtime.runProcess(command('output.cjs', {}, ['staged-async']))
    assert.equal(asyncResult.code, 0)
    assert.equal(asyncResult.stdout, 'staged-async')
    assert.deepEqual(observed, [process.execPath])

    child = runtime.spawnProcess(command('idle.cjs'))
    closed = once(child, 'close')
    watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000)
    assert.equal(runtime.childProcessHasExited(child), false)
    imported.default.setProcessTreeKillGate((request) => {
      gateCalls.push(request)
      return false
    })
    assert.equal(await runtime.signalProcessTree(child, 'SIGTERM'), false)
    await awaitChildClose(closed)
    assert.equal(runtime.childProcessHasExited(child), true)
    assert.equal(gateCalls[0].pid, child.pid)
    assert.equal(
      gateCalls[0].scope,
      process.platform === 'win32' ? 'win-taskkill-tree' : 'posix-process-group'
    )
    clearTimeout(watchdog)

    let terminated = 0
    const idle = 'idle.cjs'
    const timed = await runtime.runProcess(
      command(idle, {
        timeoutMs: 750,
        onChildTerminated: () => {
          terminated += 1
        }
      })
    )
    assert.equal(timed.timedOut, true)
    assert.equal(terminated, 1)
    assertReaped(timed)

    const controller = new AbortController()
    cancelTimer = setTimeout(() => controller.abort(), 750)
    const canceled = await runtime.runProcess(
      command(idle, {
        signal: controller.signal,
        onChildTerminated: () => {
          terminated += 1
        }
      })
    )
    assert.equal(canceled.timedOut, false)
    assert.equal(terminated, 2)
    assertReaped(canceled)
    clearTimeout(cancelTimer)

    const priorSpawns = observed.length
    const preAborted = await runtime.runProcess(command(idle, { signal: controller.signal }))
    assert.equal(preAborted.code, null)
    assert.equal(observed.length, priorSpawns, 'Already canceled work must not spawn')
    assert.equal(observed.length, 4)
    assert.ok(observed.every((program) => program === process.execPath))
    assert.equal(gateCalls.length, 1)
    return {
      sync: true,
      async: true,
      sharedState: true,
      refusal: true,
      timeout: true,
      cancel: true,
      cleanup: true
    }
  } finally {
    clearTimeout(watchdog)
    clearTimeout(cancelTimer)
    runtime.setSpawnObserver(null)
    runtime.setProcessTreeKillGate(null)
    try {
      if (child && !runtime.childProcessHasExited(child)) {
        child.kill('SIGKILL')
        await awaitChildClose(closed)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
    assert.equal(runtime.hasSpawnObserver(), false)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.match(process.versions.node, /^18\./, 'This smoke must run under actual Node 18')
  const directory = stageDirectoryFromArgs(process.argv.slice(2))
  const result = await smokeLegacyProcessHost(directory)
  console.log(
    `Node ${process.versions.node} staged pre-extraction process smoke passed: ${JSON.stringify(result)}`
  )
}
