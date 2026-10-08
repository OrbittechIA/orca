import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runProcess } from '../../shared/child-process/run-process'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import {
  runCodexHookTrustGrantSession,
  type CodexHookTrustGrantRequest
} from './codex-app-server-client'
import { buildCodexManagedHook, CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'
import { normalizeHookTrustKeyForLookup, readHookTrustEntries } from './config-toml-trust'

const binary = process.env.ORCA_CODEX_HOOK_CONTRACT_BINARY
const expectedVersion = process.env.ORCA_CODEX_HOOK_CONTRACT_VERSION
const TIMEOUT_MS = 60_000
const MANAGED_COMMAND = 'echo orca-contract-managed'
const FOREIGN_COMMAND = 'echo orca-contract-unmanaged'
const HookListing = z.object({
  key: z.string(),
  command: z.string().nullable(),
  currentHash: z.string(),
  trustStatus: z.string()
})
const HookResponse = z.object({ data: z.array(z.object({ hooks: z.array(HookListing) })) })

// Real Codex owns the hash and approval format; a stub cannot detect either drifting.
describe.runIf(process.env.ORCA_CODEX_HOOK_CONTRACT_REQUIRED === '1' && !binary)(
  'codex hook file-entry contract prerequisites',
  () => {
    it('requires the installed binary instead of silently skipping', () => {
      expect.fail('ORCA_CODEX_HOOK_CONTRACT_REQUIRED=1 but no binary was given')
    })
  }
)

describe.runIf(binary)('codex hook file-entry binary contract', { timeout: 180_000 }, () => {
  let root: string
  let configPath: string
  let request: CodexHookTrustGrantRequest

  beforeEach(async () => {
    if (!binary) {
      throw new Error('Codex contract requires a binary')
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-hook-contract-')))
    const home = join(root, 'home')
    const codexHome = join(home, '.codex')
    const cwd = join(root, 'workspace')
    for (const directory of [codexHome, cwd]) {
      mkdirSync(directory, { recursive: true })
    }
    configPath = join(codexHome, 'config.toml')
    const hooksPath = join(codexHome, 'hooks.json')
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data')
    }
    const version = await runProcess({
      program: binary,
      args: ['--version'],
      env,
      timeoutMs: TIMEOUT_MS
    })
    expect(version.code, version.stderr).toBe(0)
    if (expectedVersion) {
      expect(version.stdout.trim()).toBe(`codex-cli ${expectedVersion}`)
    }
    writeFileSync(configPath, '# unrelated owner preference\nmodel = "contract-fixture"\n')
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          CODEX_EVENTS.map((event) => [
            event,
            [
              { hooks: [buildCodexManagedHook(FOREIGN_COMMAND, event)] },
              { hooks: [buildCodexManagedHook(MANAGED_COMMAND, event)] }
            ]
          ])
        )
      })
    )
    request = {
      invocation: {
        command: binary,
        cliPath: binary,
        args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        env,
        envToDelete: Object.keys(process.env).filter(
          (key) =>
            !Object.hasOwn(env, key) &&
            /^(OPENAI_|CODEX_|ORCA_|ORBIT_|NODE_OPTIONS$|NODE_PATH$)/.test(key)
        ),
        timeoutMs: TIMEOUT_MS
      },
      hooksListCwd: cwd,
      managedCommand: MANAGED_COMMAND,
      expectedTrustKeys: CODEX_EVENTS.map((event) =>
        normalizeHookTrustKeyForLookup(`${hooksPath}:${CODEX_EVENT_LABEL[event]}:1:0`)
      )
    }
  })

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  async function listHooks() {
    return runCodexAppServerSession(request.invocation, async (rpc) => {
      const result = HookResponse.parse(
        await rpc.request('hooks/list', { cwds: [request.hooksListCwd] })
      )
      return result.data.flatMap((entry) => entry.hooks)
    })
  }

  it('persists Codex-computed approval only for the managed file entries', async () => {
    const before = await listHooks()
    const managed = before.filter((hook) => hook.command === MANAGED_COMMAND)
    const foreign = before.filter((hook) => hook.command === FOREIGN_COMMAND)
    expect(managed).toHaveLength(CODEX_EVENTS.length)
    expect(foreign).toHaveLength(CODEX_EVENTS.length)
    expect(managed.every((hook) => hook.trustStatus !== 'trusted')).toBe(true)

    const granted = await runCodexHookTrustGrantSession(request)
    expect(granted.outcome).toBe('granted')
    if (granted.outcome !== 'granted') {
      throw new Error(granted.reason)
    }
    expect(granted.wroteTrust).toBe(true)
    expect(granted.entries.map((entry) => entry.normalizedKey).sort()).toEqual(
      [...request.expectedTrustKeys].sort()
    )

    // A fresh process must accept the persisted approval, not just the granting process's cache.
    const after = await listHooks()
    const states = readHookTrustEntries(configPath)
    expect(after.filter((hook) => hook.command === FOREIGN_COMMAND)).toEqual(foreign)
    for (const hook of managed) {
      expect(after.find((entry) => entry.key === hook.key)).toMatchObject({
        currentHash: hook.currentHash,
        trustStatus: 'trusted'
      })
      expect(states.get(hook.key)?.trustedHash).toBe(hook.currentHash)
    }
    expect(readFileSync(configPath, 'utf8')).toContain('# unrelated owner preference')
  })

  it('does not rewrite an already approved file entry', async () => {
    expect((await runCodexHookTrustGrantSession(request)).outcome).toBe('granted')
    const approved = readFileSync(configPath, 'utf8')
    const repeated = await runCodexHookTrustGrantSession(request)
    expect(repeated).toMatchObject({ outcome: 'granted', wroteTrust: false })
    expect(readFileSync(configPath, 'utf8')).toBe(approved)
  })

  it('refuses an identity mismatch without approving another command', async () => {
    const original = readFileSync(configPath, 'utf8')
    const refused = await runCodexHookTrustGrantSession({
      ...request,
      managedCommand: 'echo different-command'
    })
    expect(refused).toMatchObject({ outcome: 'verify-failed', reasonClass: 'list-mismatch' })
    expect(readFileSync(configPath, 'utf8')).toBe(original)
    expect((await listHooks()).every((hook) => hook.trustStatus !== 'trusted')).toBe(true)
  })
})
