// Exercise real heartbeats and steal commands so long mutations retain activation ownership.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '@orca/process-host'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from '../activation/orcad-activation-transaction'
import { serializedStateMutationCommand } from './orcad-state-snapshot'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
import { tryStealInstallLockCommand } from '../install/remote-install-lock-commands'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'

const posix = getRemoteHostPlatform('linux-x64')
const STALE_SECONDS = 3
const HEARTBEAT_SECONDS = 0.1
const OBSERVE_HEARTBEATS_MS = 300

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(process.platform === 'win32')(
  'the fence heartbeat of a running state mutation',
  () => {
    let base = ''
    let fence = ''

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), 'orcad-fence-beat-'))
      fence = join(base, ORCAD_ACTIVATION_TRANSACTION_DIRNAME, RELAY_INSTALL_LOCK_NAME)
      mkdirSync(fence, { recursive: true })
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'holder-1')
    })
    const mutation = (script: string): string =>
      serializedStateMutationCommand(base, script, HEARTBEAT_SECONDS, {
        lockDir: fence,
        token: 'holder-1'
      })
    afterEach(() => {
      rmSync(base, { recursive: true, force: true })
    })

    const backdate = (): Promise<string> => sh(`touch -m -t 200001010000 '${fence}'`)
    const steal = (): Promise<string> => sh(tryStealInstallLockCommand(posix, fence, STALE_SECONDS))
    const age = (): number => Date.now() / 1000 - statSync(fence).mtimeMs / 1000

    it('is not stolen while a long mutation runs, and is once its holder dies', async () => {
      const run = spawnProcess({
        program: '/bin/sh',
        args: ['-c', mutation('sleep 30')]
      })
      try {
        const pidFile = join(base, 'orcad-state-mutation.lock', 'pid')
        await expect
          .poll(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim())
          .toBeTruthy()

        await backdate()
        await expect.poll(age, { timeout: 5_000, interval: 25 }).toBeLessThan(STALE_SECONDS)
        expect(age()).toBeLessThan(STALE_SECONDS)
        expect(await steal()).toBe('BUSY')

        // Kill the owner; subsequent fence freshness must come from no surviving heartbeat.
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL')
        await pause(OBSERVE_HEARTBEATS_MS)
        await backdate()
        await pause(OBSERVE_HEARTBEATS_MS)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(await steal()).toMatch(/OK$/u)
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('stops refreshing a fence another run took over mid-mutation, and keeps its token', async () => {
      const run = spawnProcess({ program: '/bin/sh', args: ['-c', mutation('sleep 6')] })
      try {
        await expect
          .poll(() => existsSync(join(base, 'orcad-state-mutation.lock', 'pid')))
          .toBe(true)
        await backdate()
        await expect.poll(age, { timeout: 5_000, interval: 25 }).toBeLessThan(STALE_SECONDS)
        writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
        await backdate()
        await pause(OBSERVE_HEARTBEATS_MS)
        expect(age()).toBeGreaterThan(STALE_SECONDS)
        expect(readFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'utf8')).toBe('successor')
      } finally {
        run.kill('SIGKILL')
      }
    }, 20_000)

    it('never starts a mutation once its run no longer owns the fence', async () => {
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
      const marker = join(base, 'mutated')
      expect(await sh(mutation(`touch '${marker}'`))).toBe('__ORCAD_FENCE_LOST__')
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(base, 'orcad-state-mutation.lock'))).toBe(false)
    }, 20_000)

    it('stops refreshing once the mutation finishes, and never creates a missing fence', async () => {
      await sh(mutation('sleep 0.3'))
      await backdate()
      await pause(OBSERVE_HEARTBEATS_MS)
      expect(age()).toBeGreaterThan(STALE_SECONDS)

      rmSync(fence, { recursive: true })
      await sh(serializedStateMutationCommand(base, ':', HEARTBEAT_SECONDS, null))
      expect(existsSync(fence)).toBe(false)
    }, 20_000)
  }
)

// /proc identifies the real child after its parent exits; production remains portable POSIX shell.
describe.skipIf(process.platform !== 'linux')('state mutation heartbeat child cleanup', () => {
  const sleep = existsSync('/bin/sleep') ? '/bin/sleep' : '/usr/bin/sleep'

  function identity(pid: number): { birth: string; state: string } | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return { birth: fields[19]!, state: fields[0]! }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  it.each([
    { name: 'a short successful mutation', code: 0, stopEarly: false },
    { name: 'a failed mutation', code: 7, stopEarly: false },
    { name: 'a heartbeat stopped as its child starts', code: 0, stopEarly: true }
  ])('reaps its own sleep after $name', async ({ code, stopEarly }) => {
    const base = mkdtempSync(join(tmpdir(), 'orcad-beat-child-'))
    const bin = join(base, 'bin')
    const pidFile = join(base, 'sleep.pid')
    const release = join(base, 'release')
    const lock = join(base, 'orcad-state-mutation.lock')
    let childPid = 0
    let childBirth: string | undefined
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'sleep'),
      [
        '#!/bin/sh',
        'if [ "$1" = 60 ]; then',
        `printf '%s\\n' "$$" > ${quotePosixShell(pidFile)}`,
        ...(stopEarly ? ['kill -TERM "$PPID"'] : []),
        'fi',
        `exec ${quotePosixShell(sleep)} "$@"`,
        ''
      ].join('\n'),
      { mode: 0o700 }
    )
    const script = [
      'attempt=0;',
      `while [ ! -f ${quotePosixShell(release)} ]; do`,
      'attempt=$((attempt + 1)); [ "$attempt" -lt 500 ] || exit 91; sleep 0.01; done;',
      `printf 'mutation-${code}\\n'; exit ${code}`
    ].join(' ')
    const running = runProcess({
      program: '/bin/sh',
      args: ['-c', serializedStateMutationCommand(base, script, 60, null)],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      timeoutMs: 10_000
    })
    try {
      await expect
        .poll(() => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : ''), {
          timeout: 5_000
        })
        .toMatch(/^[1-9]\d*\n$/u)
      childPid = Number(readFileSync(pidFile, 'utf8').trim())
      expect(Number.isInteger(childPid) && childPid > 1).toBe(true)
      childBirth = identity(childPid)?.birth
      if (!stopEarly) {
        await expect
          .poll(() => readlinkSync(`/proc/${childPid}/exe`), { timeout: 5_000 })
          .toMatch(/\/sleep$/u)
        expect(childBirth).toBeDefined()
      }
      writeFileSync(release, '')
      const result = await running
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeNull()
      // The existing wrapper reports the deadline separately and normalizes other exit codes.
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`mutation-${code}\n`)
      expect(result.stderr).toBe('')
      expect(existsSync(lock)).toBe(false)
      await expect.poll(() => identity(childPid), { timeout: 2_000 }).toBeNull()
    } finally {
      writeFileSync(release, '')
      await running
      const remaining = childPid > 1 ? identity(childPid) : null
      if (remaining && remaining.birth === childBirth && remaining.state !== 'Z') {
        process.kill(childPid, 'SIGKILL')
      }
      rmSync(base, { recursive: true, force: true })
    }
  }, 20_000)
})
