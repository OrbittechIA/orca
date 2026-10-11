import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import { captureLocalWorktreeMaterialCensus } from '../persistence/tracking-repos/local-worktree-material-census'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  acquireMaterialAdmission,
  withMaterialAdmission,
  withMaterialRestoreAdmission,
  acquireMaterialMutation
} from './runtime-worktree-material-admission'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const manifest: MaterialManifest = {
  schemaVersion: 1,
  repo: 'id:fixture',
  canonicalSource: 'example.org/team/repo',
  executionHostId: 'local',
  worktreeId: 'fixture::/fixture/missing',
  path: '/fixture/missing',
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
const identity = {
  callerFingerprint: 'caller-a',
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  method: 'worktree.materialRestore',
  payloadHash: '0'.repeat(64)
}
function harness(db: OrchestrationDb) {
  return {
    getExistingDb: () => db,
    captureCensus: (id: string) =>
      captureLocalWorktreeMaterialCensus(getDefaultPersistedState('/fixture/profile'), id)
  }
}

it('commits the target with the first claim, FULL only for that transaction, and fences after reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'material-admission-'))
  roots.push(root)
  const filename = join(root, 'ledger.sqlite')
  const db = new OrchestrationDb(filename)
  expect(db.db.pragma('synchronous', { simple: true })).toBe(1)
  const seen: number[] = []
  const execute = db.db.exec.bind(db.db)
  vi.spyOn(db.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      seen.push(Number(db.db.pragma('synchronous', { simple: true })))
    }
    return execute(sql)
  })
  db.beginMutationReceipt({ ...identity, material: manifest })
  expect(seen).toEqual([2])
  expect(db.db.pragma('synchronous', { simple: true })).toBe(1)
  expect(JSON.parse(db.getMutationReceipt('caller-a', identity.requestId)!.receipt!)).toEqual({
    materialTarget: manifest
  })
  db.close()
  const reopened = new OrchestrationDb(filename)
  try {
    expect(() =>
      reopened.beginMutationReceipt({
        ...identity,
        callerFingerprint: 'caller-b',
        requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        material: { ...manifest, historicalInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
      })
    ).toThrow('E_MATERIAL_TARGET_RESERVED')
    const effect = vi.fn(async () => {})
    for (const input of [
      { selector: `id:${manifest.worktreeId}` },
      { cwd: `${manifest.path}/partial` },
      { repoId: 'fixture', branch: 'historical' },
      { selector: 'indirect-unprovable' }
    ]) {
      await expect(withMaterialAdmission(harness(reopened), input, effect)).rejects.toThrow()
    }
    expect(effect).not.toHaveBeenCalled()
    expect(reopened.getMutationReceipt('caller-a', identity.requestId)?.state).toBe('pending')
  } finally {
    reopened.close()
  }
})

it('treats a legacy NULL target as unverifiable and preserves it', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.beginMutationReceipt({ ...identity, material: manifest })
    db.db.prepare('UPDATE mutation_receipts SET receipt = NULL').run()
    expect(db.readPendingMaterialClaims()).toBeNull()
    await expect(acquireMaterialAdmission(harness(db), { cwd: '/fixture/other' })).rejects.toThrow(
      'E_MATERIAL_ADMISSION_UNVERIFIABLE'
    )
    expect(db.getMutationReceipt('caller-a', identity.requestId)?.state).toBe('pending')
  } finally {
    db.close()
  }
})

it('rechecks claims arriving during resolution before any effect; unrelated and remote operations remain eligible', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const authority = harness(db)
    const hold = await acquireMaterialAdmission(authority, { cwd: manifest.path })
    db.beginMutationReceipt({ ...identity, material: manifest })
    expect(() => hold.revalidate()).toThrow('E_MATERIAL_TARGET_RESERVED')
    hold.release()
    expect(() => hold.revalidate()).toThrow('E_MATERIAL_ADMISSION_RELEASED')
    const effect = vi.fn(async () => 'ok')
    expect(await withMaterialAdmission(authority, { cwd: '/fixture/other' }, effect)).toBe('ok')
    expect(
      await withMaterialAdmission(authority, { cwd: manifest.path, connectionId: 'remote' }, effect)
    ).toBe('ok')
    expect(effect).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

it('does not queue restore behind desktop IPC and creates no claim while ordinary admission is held', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const authority = harness(db)
    const outer = await acquireMaterialAdmission(authority, { cwd: '/fixture/other' })
    expect(() => acquireMaterialMutation(authority, identity, manifest)).toThrow(
      'E_MATERIAL_ADMISSION_BUSY'
    )
    const ipc = await acquireMaterialAdmission(authority, { cwd: '/fixture/other' })
    ipc.release()
    outer.release()
    expect(db.getMutationReceipt('caller-a', identity.requestId)).toBeUndefined()
    const permit = acquireMaterialMutation(authority, identity, manifest)
    try {
      db.beginMutationReceipt({ ...identity, material: manifest })
      expect(
        await permit.run(() =>
          withMaterialRestoreAdmission(
            authority,
            manifest,
            identity.requestId,
            async () => 'restored'
          )
        )
      ).toBe('restored')
      await expect(acquireMaterialAdmission(authority, { cwd: '/fixture/other' })).rejects.toThrow(
        'E_MATERIAL_ADMISSION_BUSY'
      )
      const remote = await acquireMaterialAdmission(authority, {
        cwd: '/remote',
        connectionId: 'ssh-fixture'
      })
      expect(() => remote.revalidate({ cwd: '/fixture/other', executionHostId: 'local' })).toThrow(
        'E_MATERIAL_ADMISSION_BUSY'
      )
      remote.release()
    } finally {
      permit.release()
    }
    expect(
      await withMaterialAdmission(authority, { cwd: '/fixture/other' }, async () => 'ordinary')
    ).toBe('ordinary')
  } finally {
    db.close()
  }
})

it('denies unresolved selectors with safe cwd, relative escapes, folder suffixes and overlapping claims', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.beginMutationReceipt({ ...identity, material: manifest })
    for (const input of [
      { selector: 'branch:historical', cwd: '/fixture/safe' },
      { selector: 'fixture::/fixture/safe', cwd: '../missing' },
      { selector: `${manifest.worktreeId}::workspace:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }
    ]) {
      await expect(acquireMaterialAdmission(harness(db), input)).rejects.toThrow()
    }
    for (const target of ['/fixture', '/fixture/missing/child']) {
      expect(() =>
        db.beginMutationReceipt({
          ...identity,
          callerFingerprint: 'caller-b',
          requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          material: { ...manifest, path: target, branch: 'different' }
        })
      ).toThrow('E_MATERIAL_TARGET_RESERVED')
    }
  } finally {
    db.close()
  }
})

it('remote metadata never overrides a local PTY execution route', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.beginMutationReceipt({ ...identity, material: manifest })
    const state = getDefaultPersistedState('/fixture/profile')
    state.worktreeMeta['remote::/remote/workspace'] = {
      hostId: 'ssh:host',
      instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    }
    const authority = {
      getExistingDb: () => db,
      captureCensus: (id: string) => captureLocalWorktreeMaterialCensus(state, id)
    }
    await expect(
      acquireMaterialAdmission(authority, {
        selector: 'remote::/remote/workspace',
        cwd: manifest.path,
        executionHostId: 'local'
      })
    ).rejects.toThrow('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  } finally {
    db.close()
  }
})

import { BrowserWindow } from 'electron'
import { OrcaRuntimeService } from './orca-runtime'
import { createSqliteMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'
import { runPtyIpcSpawn } from '../ipc/pty/ipc/spawn-run'
import type { PtySpawnIpcDeps } from '../ipc/pty/ipc/spawn-types'
import * as replacement from '../ipc/pty/pane/pane-owner-replacement'
import * as materialization from '../ipc/pty/ipc/spawn-push-target-materialization'
import * as begin from '../ipc/pty/ipc/spawn-begin'
import * as execution from '../ipc/pty/ipc/spawn-execute'
import { createLocalWorktree } from '../ipc/worktree-remote'
import * as prepared from '../worktree-create-preparation'
import * as gitWorktrees from '../git/worktree'

vi.mock('electron', () => ({
  BrowserWindow: class {
    static fromId() {
      return null
    }
  },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => '/fixture' }
}))

function desktopDeps(runtime: OrcaRuntimeService): PtySpawnIpcDeps {
  const forbidden = () => {
    throw new Error('unexpected_desktop_effect')
  }
  return {
    runtime,
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

it('real desktop spawn refuses the reopened target claim before stop, materialization, adopt or spawn', async () => {
  const f = createSqliteMaintenanceFixture()
  const filename = join(f.directory, 'claims.sqlite')
  const first = new OrchestrationDb(filename)
  first.beginMutationReceipt({ ...identity, material: manifest })
  first.close()
  const db = new OrchestrationDb(filename)
  const runtime = new OrcaRuntimeService(f.store)
  runtime.setOrchestrationDb(db)
  const deps = desktopDeps(runtime)
  const effects = [
    vi.spyOn(replacement, 'stopReplacedPaneOwner').mockRejectedValue(new Error('stop_forbidden')),
    vi
      .spyOn(materialization, 'triggerPtySpawnPushTargetMaterialization')
      .mockImplementation(() => {}),
    vi.spyOn(begin, 'beginPtyIpcSpawn').mockResolvedValue({ isReattach: true }),
    vi.spyOn(execution, 'executePtyIpcSpawn').mockResolvedValue(undefined),
    vi.spyOn(deps, 'adoptStablePane')
  ]
  try {
    await expect(
      runPtyIpcSpawn(deps, {
        cols: 80,
        rows: 24,
        cwd: manifest.path,
        worktreeId: manifest.worktreeId,
        replacesPtyId: 'old-pty'
      })
    ).rejects.toThrow('E_MATERIAL_TARGET_RESERVED')
    effects.forEach((effect) => expect(effect).not.toHaveBeenCalled())
    expect(db.getMutationReceipt(identity.callerFingerprint, identity.requestId)?.state).toBe(
      'pending'
    )
    // Same entry, unrelated and SSH routes reach the stubbed next boundary exactly once each.
    for (const args of [
      { cwd: '/fixture/other' },
      { cwd: manifest.path, connectionId: 'ssh-fixture' }
    ]) {
      expect(await runPtyIpcSpawn(deps, { cols: 80, rows: 24, ...args })).toEqual({
        isReattach: true
      })
    }
    expect(effects[2]).toHaveBeenCalledTimes(2)
    expect(effects[0]).not.toHaveBeenCalled()
    expect(effects[3]).not.toHaveBeenCalled()
    const permit = acquireMaterialMutation(runtime.materialAdmissionAuthority, identity, manifest)
    permit.release()
  } finally {
    db.close()
    vi.restoreAllMocks()
  }
})

it('real desktop local create refuses reserved branch before prepared checkout, Git, startup or rearm', async () => {
  const f = createSqliteMaintenanceFixture()
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService(f.store)
  runtime.setOrchestrationDb(db)
  const repo = { id: 'fixture', path: '/fixture/repo', displayName: '', badgeColor: '', addedAt: 1 }
  const window = new BrowserWindow()
  const effects = [
    vi.spyOn(prepared, 'consumePreparedWorktreeCreate'),
    vi.spyOn(gitWorktrees, 'addWorktree'),
    vi.spyOn(gitWorktrees, 'addSparseWorktree'),
    vi.spyOn(runtime, 'createTerminal')
  ]
  const boundary = vi.spyOn(f.store, 'getSettings').mockImplementation(() => {
    throw new Error('ordinary_boundary')
  })
  try {
    db.beginMutationReceipt({ ...identity, material: manifest })
    await expect(
      createLocalWorktree(
        { repoId: repo.id, name: 'historical', branchNameOverride: manifest.branch },
        repo,
        f.store,
        window,
        runtime
      )
    ).rejects.toThrow('E_MATERIAL_TARGET_RESERVED')
    effects.forEach((effect) => expect(effect).not.toHaveBeenCalled())
    expect(boundary).not.toHaveBeenCalled()
    await expect(
      createLocalWorktree(
        { repoId: repo.id, name: 'neighbor', branchNameOverride: 'neighbor' },
        repo,
        f.store,
        window,
        runtime
      )
    ).rejects.toThrow('ordinary_boundary')
    expect(boundary).toHaveBeenCalledOnce()
    effects.forEach((effect) => expect(effect).not.toHaveBeenCalled())
    const permit = acquireMaterialMutation(runtime.materialAdmissionAuthority, identity, manifest)
    permit.release()
  } finally {
    db.close()
    vi.restoreAllMocks()
  }
})
