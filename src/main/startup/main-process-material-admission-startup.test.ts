import { readdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import * as HookServer from '../agent-hooks/server'
import { setMigrationUnsupportedPtyPersistenceListener } from '../agent-hooks/migration-unsupported-pty-state'
import { createSqliteMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type * as ClaimIdentity from '../runtime/agent-session-claim-identity'
import type * as ProfilePaths from '../orca-profiles/profile-storage-paths'
import type * as DataPaths from '../persistence/loading-store/user-data-path'
import { StatsCollector, initStatsPath } from '../stats/collector'
import { mainProcessState as state } from './main-process-state'
import { initializeMainProcessRuntime } from './main-process-runtime-service'
import { runPtyIpcSpawn } from '../ipc/pty/ipc/spawn-run'
import type { PtySpawnIpcDeps } from '../ipc/pty/ipc/spawn-types'
import * as begin from '../ipc/pty/ipc/spawn-begin'

const host = vi.hoisted(() => ({ root: '/unfinalized-profile', exposed: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => host.root, getVersion: () => 'test', once: vi.fn() },
  BrowserWindow: class {
    static fromId() {
      return null
    }
  },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  installChildSessionSearchService: host.exposed,
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: vi.fn()
}))
vi.mock('../runtime/agent-session-claim-identity', async (original) => ({
  ...(await original<typeof ClaimIdentity>()),
  loadAgentSessionClaimSigner: () => undefined
}))
vi.mock('../orca-profiles/profile-storage-paths', async (original) => ({
  ...(await original<typeof ProfilePaths>()),
  getProfileUserDataPath: () => host.root
}))
vi.mock('../persistence/loading-store/user-data-path', async (original) => ({
  ...(await original<typeof DataPaths>()),
  getCanonicalUserDataPath: () => host.root
}))
vi.mock('../agent-hooks/server', async (original) => {
  const actual = await original<typeof HookServer>()
  class FixtureAgentHookServer extends actual.AgentHookServer {
    // Keep real in-memory aliases/listeners without opening the hook transport or its files.
    override start(..._args: Parameters<HookServer.AgentHookServer['start']>): Promise<void> {
      return Promise.resolve()
    }
  }
  return { ...actual, agentHookServer: new FixtureAgentHookServer() }
})
vi.mock('../browser/browser-manager', () => ({
  browserManager: { setBrowserGuestStateChangedListener: vi.fn() }
}))
vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: () => null,
  getSshPtyProvider: () => null,
  clearProviderPtyState: vi.fn()
}))
vi.mock('../daemon/daemon-init', () => ({ getDaemonProvider: () => null }))
vi.mock('./codex-launch-preparation', () => ({
  codexStructuredLaunchHomeResolvers: {},
  prepareCodexRuntimeHomeForLaunch: vi.fn()
}))
vi.mock('./codex-session-resume-launch', () => ({ prepareCodexPinnedLaunchHome: vi.fn() }))

const manifest: MaterialManifest = {
  schemaVersion: 1,
  repo: 'id:fixture',
  canonicalSource: 'example.org/team/repo',
  executionHostId: 'local',
  worktreeId: 'fixture::/fixture/reserved',
  path: '/fixture/reserved',
  branch: 'historical',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  linkedIssue: 413,
  linkedReview: 411,
  historicalInstanceId: null,
  runId: 'fixture',
  capsuleSHA256: 'c'.repeat(64),
  expectedMetadataDigest: 'd'.repeat(64),
  expectedCatalogDigest: 'e'.repeat(64),
  expectedPlanDigest: 'f'.repeat(64)
}
const claim = {
  callerFingerprint: 'fixture-caller',
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  method: 'worktree.materialRestore',
  payloadHash: '0'.repeat(64),
  material: manifest
}
let runtime: OrcaRuntimeService | undefined
beforeEach(() => {
  HookServer.agentHookServer.stop()
  setMigrationUnsupportedPtyPersistenceListener(null)
  const fixture = createSqliteMaintenanceFixture()
  host.root = fixture.directory
  vi.spyOn(getAppEnvironment(), 'getPath').mockImplementation(() => host.root)
  initStatsPath()
  state.store = fixture.store
  state.stats = new StatsCollector()
  state.runtime = null
  state.mainWindow = null
  host.exposed.mockClear()
  vi.spyOn(OrcaRuntimeService.prototype, 'rehydrateClientHostedBrowserPages').mockImplementation(
    () => {}
  )
})
afterEach(() => {
  HookServer.agentHookServer.stop()
  setMigrationUnsupportedPtyPersistenceListener(null)
  runtime?.materialReceiptDb()?.close()
  runtime = undefined
  state.runtime = null
  state.store = null
  state.stats = null
  vi.restoreAllMocks()
})

function spawnDeps(owner: OrcaRuntimeService): PtySpawnIpcDeps {
  const forbidden = () => {
    throw new Error('unexpected_spawn_effect')
  }
  return {
    runtime: owner,
    getLocalPtyStartupPromise: () => undefined,
    adoptStablePane: async () => null,
    assertFolderWorkspacePtyPathUsable: forbidden,
    resolvePtySpawnStartupCwd: (_id, cwd) => cwd,
    localStartupCwdDirectoryExists: forbidden,
    prepareCodexResumeHome: forbidden,
    noCodexResumeLaunch: forbidden,
    resolveCodexResumeLaunch: forbidden,
    reconcileSharedRuntimeResumeHome: forbidden,
    stripSequencedStartupResumeArgv: (env) => env,
    transitionSpawnHiddenRendererPtyDeliveryState: forbidden,
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: forbidden,
    syncPtyBackgroundedDelivery: forbidden,
    stopReplacedPty: forbidden
  }
}

it.each(['empty', 'pending', 'absent'] as const)(
  'boots the real owner before desktop/serve exposure: %s ledger',
  async (kind) => {
    const filename = join(host.root, 'orchestration.db')
    if (kind !== 'absent') {
      const seed = new OrchestrationDb(filename)
      if (kind === 'pending') {
        seed.beginMutationReceipt(claim)
      }
      seed.close()
    }
    const relay = vi.spyOn(OrcaRuntimeService.prototype, 'ensureOrchestrationFederationRelay')
    const opening = vi.spyOn(OrcaRuntimeService.prototype, 'getOrchestrationDb')
    const beginSpawn = vi.spyOn(begin, 'beginPtyIpcSpawn').mockResolvedValue({ isReattach: true })
    const claimsRead = vi.spyOn(OrchestrationDb.prototype, 'readPendingMaterialClaims')
    host.exposed.mockImplementationOnce(() => {
      expect(state.runtime).toBeNull()
      // The owner must observe the ledger before any downstream service can use it.
      if (kind !== 'absent') {
        expect(claimsRead).toHaveReturnedWith(kind === 'pending' ? [manifest] : [])
      }
      expect(opening).not.toHaveBeenCalled()
    })
    runtime = initializeMainProcessRuntime()
    expect(state.runtime).toBe(runtime)
    expect(state.mainWindow).toBeNull()
    const deps = spawnDeps(runtime)
    await expect(
      runPtyIpcSpawn(deps, { cols: 80, rows: 24, cwd: '/fixture/other' })
    ).resolves.toEqual({ isReattach: true })
    if (kind === 'pending') {
      await expect(
        runPtyIpcSpawn(deps, { cols: 80, rows: 24, cwd: manifest.path })
      ).rejects.toThrow('E_MATERIAL_TARGET_RESERVED')
      const row = runtime
        .materialReceiptDb()
        ?.getMutationReceipt(claim.callerFingerprint, claim.requestId)
      expect(row).toMatchObject({ state: 'pending', payload_hash: claim.payloadHash })
      expect(JSON.parse(row?.receipt ?? 'null')).toEqual({ materialTarget: manifest })
    }
    expect(beginSpawn).toHaveBeenCalledOnce()
    expect(relay).not.toHaveBeenCalled()
    expect(opening).not.toHaveBeenCalled()
    if (kind === 'absent') {
      expect(runtime.materialReceiptDb()).toBeNull()
      expect(readdirSync(host.root).filter((name) => name.startsWith('orchestration.db'))).toEqual(
        []
      )
    } else {
      expect(runtime.materialReceiptDb()).not.toBeNull()
    }
  }
)

it('refuses corrupt storage before publishing the runtime or starting services', () => {
  writeFileSync(join(host.root, 'orchestration.db'), 'corrupt fixture')
  expect(() => initializeMainProcessRuntime()).toThrow('file is not a database')
  expect(state.runtime).toBeNull()
  expect(host.exposed).not.toHaveBeenCalled()
  expect(readFileSync(join(host.root, 'orchestration.db'), 'utf8')).toBe('corrupt fixture')
})

it('refuses a dangling ledger symlink without creating its target or exposing the runtime', () => {
  const target = join(host.root, 'absent-ledger-target')
  symlinkSync(target, join(host.root, 'orchestration.db'))
  expect(() => initializeMainProcessRuntime()).toThrow('ledger_not_regular_file')
  expect(existsSync(target)).toBe(false)
  expect(state.runtime).toBeNull()
  expect(host.exposed).not.toHaveBeenCalled()
})

it('refuses unverifiable persisted claims instead of erasing UNKNOWN', () => {
  const filename = join(host.root, 'orchestration.db')
  const seed = new OrchestrationDb(filename)
  seed.beginMutationReceipt(claim)
  seed.db.prepare('UPDATE mutation_receipts SET receipt = NULL').run()
  seed.close()
  expect(() => initializeMainProcessRuntime()).toThrow('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  expect(state.runtime).toBeNull()
  expect(host.exposed).not.toHaveBeenCalled()
  const check = new OrchestrationDb(filename)
  try {
    expect(check.getMutationReceipt(claim.callerFingerprint, claim.requestId)).toMatchObject({
      state: 'pending',
      receipt: null
    })
  } finally {
    check.close()
  }
})
