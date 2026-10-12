import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import { createSqliteMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'
import type { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { acquireMaterialAdmission } from '../runtime/runtime-worktree-material-admission'
import { startOrcad, type OrcadHandle } from './orcad-entry'

const host = vi.hoisted(() => ({
  root: '/unfinalized-profile',
  stores: new Array<Store>(),
  runtimes: new Array<OrcaRuntimeService>(),
  stages: new Array<string>(),
  probe: vi.fn<(runtime: OrcaRuntimeService, stage: string) => Promise<void>>(),
  ready: vi.fn(),
  daemon: vi.fn(async () => {})
}))
vi.mock('electron', () => ({
  app: { getPath: () => host.root },
  BrowserWindow: class {
    static fromId() {
      return null
    }
  },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => host.root,
  resolveOrcadPath: () => host.root,
  resolveUserDataPath: () => host.root
}))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: async () => null }))
vi.mock('./orcad-cli-launcher', () => ({
  prepareOrcadCliLauncher: async () => {},
  getOrcadCliLauncherPath: () => ''
}))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: host.daemon,
  stopOrcadDaemon: async () => {}
}))
vi.mock('./orcad-observability', () => ({ installOrcadObservability: () => () => {} }))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: async () => ({}) }))
vi.mock('./orcad-automations', () => ({
  startOrcadAutomations: vi.fn(),
  stopOrcadAutomationScheduler: vi.fn(),
  orcadAutomationsKeepHostBusy: () => false
}))
vi.mock('./orcad-managed-idle-exit-host', () => ({
  beginOrcadIdleExit: () => ({ previousIdleStop: null, start: async () => {} }),
  bindOrcadIdleShutdown: vi.fn()
}))
vi.mock('./orcad-session-search', () => ({
  installOrcadSessionSearchService: async () => ({ apply: vi.fn(), dispose: vi.fn() })
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: vi.fn()
}))
vi.mock('../daemon/daemon-init', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/parcel-watcher-process', () => ({ disposeWatcherProcessAndWait: async () => {} }))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    start: async () => {},
    stop: async () => {},
    subscribeEnrichedStatus: () => () => {},
    setStatusHooksEnabled: vi.fn(),
    getStatusSnapshot: () => []
  }
}))
vi.mock('../agent-hooks/hook-status-session-tabs-republish', () => ({
  installHookStatusSessionTabsRepublish: () => () => {}
}))
vi.mock('../runtime/headless-runtime-graph', () => ({ publishHeadlessRuntimeGraph: vi.fn() }))
vi.mock('../runtime/push/desktop-push-service', () => ({
  DesktopPushService: { create: () => null }
}))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    publish = host.ready
  }
}))
vi.mock('./orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async (path: string) => {
    expect(path).toBe(host.root)
    host.stages.push('profile-final')
    return {
      store: host.stores[0],
      authority: {
        backend: 'sqlite',
        classification: 'established',
        authority_mode: 'sqlite-established',
        runtime: 'orcad',
        migrated: false
      }
    }
  }
}))
vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: async (runtime: OrcaRuntimeService) => {
    host.runtimes.push(runtime)
    host.stages.push('register-headless')
    await host.probe(runtime, 'register-headless')
  },
  getLocalPtyProvider: () => null,
  getSshPtyProvider: () => null
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    constructor(private readonly input: ConstructorParameters<typeof OrcaRuntimeRpcServer>[0]) {}
    async start() {
      expect(this.input.runtime).toBe(host.runtimes[0])
      host.stages.push('rpc')
      await host.probe(host.runtimes[0], 'rpc')
    }
    async stop() {}
    getWebSocketEndpoint() {
      return null
    }
  }
}))

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
let handle: OrcadHandle | undefined
beforeEach(() => {
  const fixture = createSqliteMaintenanceFixture()
  host.root = fixture.directory
  host.stores.splice(0, host.stores.length, fixture.store)
  host.stages.length = 0
  host.runtimes.length = 0
  host.ready.mockClear()
  host.probe.mockReset()
  vi.spyOn(OrcaRuntimeService.prototype, 'rehydrateClientHostedBrowserPages').mockImplementation(
    () => {}
  )
  vi.spyOn(
    OrcaRuntimeService.prototype,
    'refreshRestoredOrchestrationAuthority'
  ).mockImplementation(async () => {
    host.stages.push('refresh')
  })
  // Recovery is an independent redrive boundary; it must not warm the ledger for the assertion.
  vi.spyOn(OrcaRuntimeService.prototype, 'reconcileLegacyWorkerTerminals').mockImplementation(
    async () => {
      host.stages.push('recovery')
      return { adoptedDispatchIds: [], exitedDispatchIds: [], deferredDispatchIds: [] }
    }
  )
})
afterEach(async () => {
  const current = handle
  handle = undefined
  try {
    await current?.stop()
  } finally {
    for (const runtime of host.runtimes) {
      runtime.materialReceiptDb()?.close()
    }
    vi.restoreAllMocks()
  }
})

it.each(['empty', 'pending', 'absent'] as const)(
  'prepares real claims before headless registration and RPC: %s ledger',
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
    host.probe.mockImplementation(async (runtime, stage) => {
      expect(getAppEnvironment().getPath('userData')).toBe(host.root)
      if (stage === 'register-headless') {
        expect(host.stages).toEqual(['profile-final', 'register-headless'])
      }
      const permit = await acquireMaterialAdmission(runtime.materialAdmissionAuthority, {
        cwd: '/fixture/other'
      })
      permit.revalidate()
      permit.release()
      const boundary = vi
        .spyOn(runtime, 'getAvailableAuthoritativeWindow')
        .mockImplementation(() => {
          throw new Error('ordinary_terminal_boundary')
        })
      try {
        await expect(runtime.createTerminal(undefined, { cwd: '/fixture/other' })).rejects.toThrow(
          'ordinary_terminal_boundary'
        )
        expect(boundary).toHaveBeenCalledOnce()
        if (kind === 'pending') {
          await expect(
            acquireMaterialAdmission(runtime.materialAdmissionAuthority, { cwd: manifest.path })
          ).rejects.toThrow('E_MATERIAL_TARGET_RESERVED')
          expect(
            runtime
              .materialReceiptDb()
              ?.getMutationReceipt(claim.callerFingerprint, claim.requestId)
          ).toMatchObject({ state: 'pending', payload_hash: claim.payloadHash })
        }
        expect(relay).not.toHaveBeenCalled()
        expect(opening).not.toHaveBeenCalled()
        if (kind === 'absent') {
          expect(
            readdirSync(host.root).filter((name) => name.startsWith('orchestration.db'))
          ).toEqual([])
        }
      } finally {
        boundary.mockRestore()
      }
    })
    handle = await startOrcad({ noPairing: true, json: true })
    expect(host.stages).toEqual([
      'profile-final',
      'register-headless',
      'refresh',
      'recovery',
      'rpc'
    ])
    expect(host.probe).toHaveBeenCalledTimes(2)
    expect(host.ready).toHaveBeenCalledOnce()
  }
)

it('refuses corrupt storage before headless registration, recovery, RPC or readiness', async () => {
  writeFileSync(join(host.root, 'orchestration.db'), 'corrupt fixture')
  await expect(startOrcad({ noPairing: true, json: true })).rejects.toThrow(
    'file is not a database'
  )
  expect(host.stages).toEqual(['profile-final'])
  expect(host.probe).not.toHaveBeenCalled()
  expect(host.ready).not.toHaveBeenCalled()
  expect(readFileSync(join(host.root, 'orchestration.db'), 'utf8')).toBe('corrupt fixture')
})
