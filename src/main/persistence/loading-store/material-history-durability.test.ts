import { afterEach, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { pruneUnreferencedWorktreeIdentityMeta } from './worktree-identity-metadata'
import { stageMaterialHistoryState } from '../tracking-repos/local-worktree-material-census'
import { hashCanonical } from '../../runtime/rpc/orchestration-mutation-receipt'
import { materialHistoryDigest } from '../../../shared/worktree/material-types'

const fixtureResources: (() => void)[] = []
afterEach(() => {
  for (const close of fixtureResources.splice(0).toReversed()) {
    close()
  }
  vi.unstubAllEnvs()
})

it('persistence digest matches the RPC ledger canonical encoding', () => {
  const values = [
    null,
    [],
    { z: [null, { y: 1, x: 2 }], a: undefined },
    { '10': 'ten', '2': 'two', nested: { z: true, a: 'á' } }
  ]
  for (const value of values) {
    expect(materialHistoryDigest(value)).toBe(hashCanonical(value))
  }
})

const oldInstance = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const metadata: WorktreeMeta = {
  instanceId: oldInstance,
  hostId: 'local',
  displayName: 'historical',
  comment: 'retain me',
  linkedIssue: 413,
  linkedPR: 411,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

it('retains the historical canonical row when identity rotation makes it unreferenced', () => {
  const state = getDefaultPersistedState('/synthetic-profile')
  const key = canonicalWorktreeIdentity({
    worktreeId: 'repo::/fixture/missing',
    executionHostId: 'local',
    instanceId: oldInstance
  })
  const id = 'repo::/fixture/missing'
  state.worktreeMeta[id] = structuredClone(metadata)
  stageMaterialHistoryState(state, historyManifest(id), requestId)
  const retained = state.worktreeMetaByIdentity![key]
  delete state.worktreeMeta[id]
  state.worktreeIdentityAliases = {}
  expect(pruneUnreferencedWorktreeIdentityMeta(state)).toBe(false)
  expect(state.worktreeMetaByIdentity![key]).toEqual(retained)
})

import { vi } from 'vitest'
import {
  createWorkerMaintenanceFixture,
  createSqliteMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { Store } from './store'
import type { MaterialManifest } from '../../../shared/worktree/material-types'

function historyManifest(id: string): MaterialManifest {
  return {
    schemaVersion: 1,
    repo: 'id:repo',
    canonicalSource: 'example.org/team/repo',
    executionHostId: 'local',
    worktreeId: id,
    path: id.slice(id.indexOf('::') + 2),
    branch: 'old',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    linkedIssue: 413,
    linkedReview: 411,
    historicalInstanceId: oldInstance,
    runId: 'fixture',
    capsuleSHA256: 'c'.repeat(64),
    expectedMetadataDigest: hashCanonical(metadata)
  }
}

async function stage(
  f: Pick<Awaited<ReturnType<typeof createWorkerMaintenanceFixture>>, 'store' | 'directory'>
) {
  const id = `history-fixture::${f.directory}/missing`
  const manifest = historyManifest(id)
  const assertion = await f.store.runDurableMutation(() => {
    f.store.getAllWorktreeMeta()[id] = structuredClone(metadata)
    return { value: f.store.stageMaterialHistory(manifest, requestId) }
  })
  return { assertion, id, manifest }
}

it('real worker ACK precedes rotation and reload GC retains legacy-only history', async () => {
  const f = await createWorkerMaintenanceFixture()
  const { assertion, id } = await stage(f)
  const original = f.authority.assertMaterialHistory.bind(f.authority)
  let acknowledged = false
  vi.spyOn(f.authority, 'assertMaterialHistory').mockImplementation(async (expected) => {
    await original(expected)
    acknowledged = true
  })
  const next = await f.store.runDurableMutation(
    () => {
      expect(acknowledged).toBe(true)
      return { value: f.store.publishMaterialIdentity(assertion) }
    },
    { materialHistory: assertion }
  )
  expect(next).not.toBe(oldInstance)
  expect(f.store.getWorktreeMeta(id)).not.toHaveProperty('materialHistory')
  await f.store.freezeWritesAsync()
  const authority = new ProfileStateSqliteAuthority(f.databaseFile, f.profileId)
  const reloaded = new Store({ dataFile: f.dataFile, profileStateAuthority: authority })
  try {
    const census = reloaded.captureLocalWorktreeMaterialCensus(id)
    const old = census.rows.find((row) => row.instanceId === oldInstance)
    expect(old?.metadata.materialHistory?.snapshot).toEqual(metadata)
    expect(old?.metadata.materialHistory?.representations).toEqual({
      legacy: true,
      canonicalKeys: [],
      aliases: {}
    })
    expect(census.complete).toBe(true)
  } finally {
    await reloaded.freezeWritesAsync()
  }
})

it('real worker readback cannot publish metadata changed while the ACK was pending', async () => {
  const f = await createWorkerMaintenanceFixture()
  const { assertion, id } = await stage(f)
  const waiting = maintenanceBarrier()
  const entered = maintenanceBarrier()
  const real = f.authority.assertMaterialHistory.bind(f.authority)
  vi.spyOn(f.authority, 'assertMaterialHistory').mockImplementation(async (expected) => {
    entered.resolve()
    await waiting.promise
    return real(expected)
  })
  const publish = f.store.runDurableMutation(
    () => ({ value: f.store.publishMaterialIdentity(assertion) }),
    { materialHistory: assertion }
  )
  await entered.promise
  f.store.getAllWorktreeMeta()[id].linkedIssue = 999
  const check = expect(publish).rejects.toThrow('E_MATERIAL_METADATA_CONFLICT')
  waiting.resolve()
  await check
  expect(f.store.getAllWorktreeMeta()[id].instanceId).toBe(oldInstance)
})

it('revision drift and corrupted expected history refuse before the publication callback', async () => {
  const f = await createWorkerMaintenanceFixture()
  const { assertion } = await stage(f)
  const callback = vi.fn(() => ({ value: 'forbidden' }))
  await expect(
    f.store.runDurableMutation(callback, {
      materialHistory: { ...assertion, historyDigest: 'f'.repeat(64) }
    })
  ).rejects.toMatchObject({
    code: 'E_MATERIAL_HISTORY_UNVERIFIABLE',
    message: 'E_MATERIAL_HISTORY_UNVERIFIABLE',
    outcome: 'known-failure'
  })
  // The read-only refusal keeps the same writer available and cannot call publication.
  await expect(f.authority.assertMaterialHistory(assertion)).resolves.toBeUndefined()
  expect(callback).not.toHaveBeenCalled()
  const peer = f.peer()
  try {
    peer.readInitialState()
    peer.writeSerializedDomains([{ domain: 'syntheticRevision', payload: '1' }])
  } finally {
    peer.close()
  }
  await expect(
    f.store.runDurableMutation(callback, { materialHistory: assertion })
  ).rejects.toMatchObject({
    code: 'E_MATERIAL_HISTORY_REVISION_CONFLICT',
    outcome: 'known-failure'
  })
  expect(callback).not.toHaveBeenCalled()
})

it('real SQLite bounded assertion refuses oversized domains without publishing', async () => {
  const f = createSqliteMaintenanceFixture()
  const { assertion } = await stage(f)
  f.authority.writeSerializedDomains([
    {
      domain: 'worktreeMetaByIdentity',
      payload: JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) })
    }
  ])
  const callback = vi.fn(() => ({ value: 'forbidden' }))
  await expect(
    f.store.runDurableMutation(callback, { materialHistory: assertion })
  ).rejects.toThrow('E_MATERIAL_HISTORY_LIMIT')
  expect(callback).not.toHaveBeenCalled()
})

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../git/runner'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { WORKTREE_MATERIAL_METHODS } from '../../runtime/rpc/methods/worktree-material'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import * as slot from '../../runtime/agent-session-record-store-slot'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { MaterialRestoredReceipt } from '../../../shared/rpc-contract/worktree-material-params'

async function wholeMaterialFixture() {
  const f = await createWorkerMaintenanceFixture()
  const root = f.directory
  const repoPath = join(root, 'repo')
  await mkdir(repoPath)
  const config = join(root, 'empty-gitconfig')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_SYSTEM', config)
  const git = async (...args: string[]) =>
    (await gitExecFileAsync(args, { cwd: repoPath })).stdout.trim()
  await git('init', '--quiet')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await git('remote', 'add', 'origin', 'https://example.org/team/repo.git')
  await writeFile(join(repoPath, 'material.txt'), 'historical content\n')
  await git('add', 'material.txt')
  await git('commit', '--quiet', '-m', 'synthetic material')
  const target = join(root, 'missing')
  await git('worktree', 'add', '-b', 'historical', target)
  const admin = (await readFile(join(target, '.git'), 'utf8')).trim().slice(8)
  const index = await readFile(join(admin, 'index'))
  await rm(target, { recursive: true })
  const manifest = {
    ...historyManifest(`repo::${target}`),
    branch: 'historical',
    head: await git('rev-parse', 'historical'),
    tree: await git('rev-parse', 'historical^{tree}')
  }
  const repo = {
    id: 'repo',
    path: repoPath,
    displayName: '',
    badgeColor: '',
    addedAt: 1,
    executionHostId: 'local' as const
  }
  await f.store.runDurableMutation(() => {
    f.store.addRepo(repo)
    f.store.getAllWorktreeMeta()[manifest.worktreeId] = structuredClone(metadata)
    return { value: undefined }
  })
  const records = await openTestAgentSessionRecordStore(join(root, 'records'))
  fixtureResources.push(() => closeTestJournalHostDatabase(join(root, 'records')))
  vi.spyOn(slot, 'peekOpenedAgentSessionRecordStore').mockReturnValue(records)
  const runtime = new OrcaRuntimeService(f.store)
  let processesCurrent = true
  const spawn = vi.fn(async () => {
    throw new Error('spawn_forbidden')
  })
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    spawn,
    observeMaterialCensus: async () => ({
      state: 'complete',
      processes: [],
      stillCurrent: () => processesCurrent
    })
  })
  const db = new OrchestrationDb(join(root, 'claims.sqlite'))
  fixtureResources.push(() => db.close())
  runtime.setOrchestrationDb(db)
  const plan = await runtime.planMaterial(manifest)
  expect(plan).toMatchObject({
    state: 'ready',
    materializable: true,
    coverage: { git: true, hostMetadata: 'complete', processes: 'complete' }
  })
  const finalManifest = {
    ...manifest,
    expectedPlanDigest: plan.planDigest,
    expectedCatalogDigest: plan.catalogDigest!
  }
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_MATERIAL_METHODS })
  return {
    ...f,
    db,
    runtime,
    repo,
    admin,
    index,
    target,
    manifest: finalManifest,
    spawn,
    invalidateProcesses: () => {
      processesCurrent = false
    },
    restore: () =>
      dispatcher.dispatch(
        {
          id: 'synthetic-restore',
          authToken: 'synthetic',
          method: 'worktree.materialRestore',
          orchestrationRequestId: requestId,
          params: { manifest: finalManifest, requestId }
        },
        { authenticatedCallerFingerprint: 'fixture-caller' }
      ),
    close: () => {
      for (const close of fixtureResources.splice(0).toReversed()) {
        close()
      }
      vi.unstubAllEnvs()
    }
  }
}

it('whole public restore commits exact Git material, durable history and typed receipt without spawn or settlement', async () => {
  const f = await wholeMaterialFixture()
  try {
    const response = await f.restore()
    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.code)
    }
    const receipt = MaterialRestoredReceipt.parse(response.result)
    expect(receipt.manifest).toEqual(f.manifest)
    expect(receipt.instanceId).not.toBe(oldInstance)
    expect(receipt.writerConfirmed).toBe(false)
    expect(await readFile(join(f.target, 'material.txt'), 'utf8')).toBe('historical content\n')
    expect(await readFile(join(f.admin, 'index'))).toEqual(f.index)
    expect(f.store.getWorktreeMeta(f.manifest.worktreeId)?.instanceId).toBe(receipt.instanceId)
    expect(f.db.getMutationReceipt('fixture-caller', requestId)?.state).toBe('completed')
    expect(f.spawn).not.toHaveBeenCalled()
    expect(await f.restore()).toMatchObject({
      ok: true,
      result: { mutation: { requestId, replayed: true } }
    })
    const history = f.store
      .captureLocalWorktreeMaterialCensus(f.manifest.worktreeId)
      .rows.find((row) => row.instanceId === oldInstance)?.metadata.materialHistory
    expect(history?.snapshot).toEqual(metadata)
  } finally {
    f.close()
  }
})

it.each(['repo', 'ownership', 'process', 'pre-stage'] as const)(
  'whole restore retains pending and old identity after %s drift during history ACK',
  async (drift) => {
    const f = await wholeMaterialFixture()
    if (drift === 'pre-stage') {
      const mutation = f.store.runDurableMutation.bind(f.store)
      vi.spyOn(f.store, 'runDurableMutation').mockImplementationOnce((callback, admission) => {
        f.invalidateProcesses()
        return mutation(callback, admission)
      })
    }
    const acknowledge = f.authority.assertMaterialHistory.bind(f.authority)
    vi.spyOn(f.authority, 'assertMaterialHistory').mockImplementation(async (expected) => {
      await acknowledge(expected)
      if (drift === 'repo') {
        f.repo.path = join(f.directory, 'different-repo')
      }
      if (drift === 'ownership') {
        f.store.getAllWorktreeMeta()['neighbor::/fixture/new-neighbor'] = {
          ...metadata,
          instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        }
      }
      if (drift === 'process') {
        f.invalidateProcesses()
      }
    })
    try {
      const response = await f.restore()
      expect(response).toMatchObject({ ok: false, error: { code: 'operation_unknown' } })
      expect(existsSync(f.target)).toBe(true)
      expect(f.store.getWorktreeMeta(f.manifest.worktreeId)?.instanceId).toBe(oldInstance)
      expect(f.db.getMutationReceipt('fixture-caller', requestId)?.state).toBe('pending')
      expect(f.spawn).not.toHaveBeenCalled()
      // A refusal before publication does not freeze unrelated profile persistence.
      await f.store.runDurableMutation(() => {
        f.store.getAllWorktreeMeta()['neighbor::/fixture/persistence-control'] = {
          ...metadata,
          instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          comment: 'durable control'
        }
        return { value: undefined }
      })
      expect(f.readState().worktreeMeta['neighbor::/fixture/persistence-control'].comment).toBe(
        'durable control'
      )
      expect(await f.restore()).toMatchObject({ ok: false, error: { code: 'operation_unknown' } })
      expect(await readFile(join(f.admin, 'index'))).toEqual(f.index)
    } finally {
      f.close()
    }
  }
)
