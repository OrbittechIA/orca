import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const paths: string[] = []
afterEach(() => {
  for (const folder of paths.splice(0)) {
    rmSync(folder, { recursive: true, force: true })
  }
})
import { WORKTREE_MATERIAL_METHODS } from './worktree-material'
import { WorktreeMaterialPlan } from '../../../../shared/rpc-contract/worktree-material-params'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import {
  isDurableMutation,
  isOrchestrationMutation
} from '../../../../shared/orchestration-rpc-contract'

it('adds only the new durable mutation, preserving old mixed-version methods', () => {
  expect(isDurableMutation('worktree.materialRestore', {})).toBe(true)
  expect(isOrchestrationMutation('worktree.materialRestore', {})).toBe(false)
  for (const method of ['worktree.materialPlan', 'worktree.materialShow', 'worktree.create']) {
    expect(isDurableMutation(method, {})).toBe(false)
  }
  expect(WORKTREE_MATERIAL_METHODS.every((method) => method.permission === 'workspace')).toBe(true)
})

it('show peeks cold state without opening SQLite or creating caller identity', async () => {
  const runtime = new OrcaRuntimeService()
  const open = vi.spyOn(runtime, 'getOrchestrationDb')
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_MATERIAL_METHODS })
  const result = await dispatcher.dispatch({
    id: 'show',
    authToken: 'fixture',
    method: 'worktree.materialShow',
    params: { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  })
  expect(result).toMatchObject({
    ok: true,
    result: { state: 'unverifiable', retryAllowed: false, writerConfirmed: false }
  })
  expect(open).not.toHaveBeenCalled()
})

it('restore without durable claim refuses before plan, hooks, agents, PTY or metadata', async () => {
  const runtime = new OrcaRuntimeService()
  const plan = vi.spyOn(runtime, 'planMaterial')
  const create = vi.spyOn(runtime, 'createManagedWorktree')
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_MATERIAL_METHODS })
  const manifest = {
    schemaVersion: 1,
    repo: 'id:fixture',
    canonicalSource: 'example.org/team/repo',
    executionHostId: 'local',
    worktreeId: 'fixture::/fixture/absent',
    path: '/fixture/absent',
    branch: 'old',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    linkedIssue: 413,
    linkedReview: 411,
    historicalInstanceId: null,
    runId: 'old',
    capsuleSHA256: 'a'.repeat(64),
    expectedMetadataDigest: 'b'.repeat(64),
    expectedCatalogDigest: 'c'.repeat(64),
    expectedPlanDigest: 'd'.repeat(64)
  }
  expect(WorktreeMaterialPlan.safeParse({ manifest, force: true }).success).toBe(false)
  const result = await dispatcher.dispatch({
    id: 'restore',
    authToken: 'fixture',
    method: 'worktree.materialRestore',
    params: { manifest, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
  expect(plan).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

// Execute these SQLite fixtures with Node and the existing Vitest node project.
import { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationMutationExecutor } from '../../rpc/orchestration-mutation-executor'
import type { DurableMutationInvocation } from '../../rpc/orchestration-mutation-executor'
import type { RpcRequest } from '../../rpc/core'

function ledger(dbFile = ':memory:') {
  const db = new OrchestrationDb(dbFile)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  return { db, runtime, executor: new OrchestrationMutationExecutor(runtime) }
}
function request(requestId: string, method = 'worktree.materialRestore'): RpcRequest {
  return {
    id: 'fixture-rpc',
    authToken: 'fixture-token',
    method,
    orchestrationRequestId: requestId
  }
}

const tuple = {
  schemaVersion: 1 as const,
  repo: 'id:fixture',
  canonicalSource: 'example.org/team/repo',
  executionHostId: 'local',
  worktreeId: 'fixture::/fixture/absent',
  path: '/fixture/absent',
  branch: 'old',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  linkedIssue: 413,
  linkedReview: 411,
  historicalInstanceId: '11111111-1111-4111-8111-111111111111',
  runId: 'fixture',
  capsuleSHA256: 'c'.repeat(64),
  expectedMetadataDigest: 'd'.repeat(64),
  expectedCatalogDigest: 'e'.repeat(64),
  expectedPlanDigest: 'f'.repeat(64)
}
function payload(requestId: string, manifest = tuple) {
  return { requestId, manifest }
}
function receipt(requestId: string, manifest = tuple) {
  return {
    schemaVersion: 1,
    state: 'restored',
    requestId,
    manifest,
    historicalInstanceId: manifest.historicalInstanceId,
    instanceId: '22222222-2222-4222-8222-222222222222',
    adminDigest: '1'.repeat(64),
    indexDigest: '2'.repeat(64),
    historyDigest: '3'.repeat(64),
    coverage: { git: true, hostMetadata: 'complete', processes: 'complete' },
    retryAllowed: false,
    writerConfirmed: false
  }
}

it('real SQLite claims once across concurrent calls and replays after reopen; isolates caller and payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-material-ledger-'))
  paths.push(root)
  const filename = join(root, 'fixture.sqlite')
  const first = ledger(filename)
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let release: ((value: unknown) => void) | undefined
  const invoke = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const initial = first.executor.run(request(id), payload(id), invoke, 'caller-a')
  await Promise.resolve()
  const concurrent = first.executor.run(request(id), payload(id), invoke, 'caller-a')
  expect(first.db.getMutationReceipt('caller-a', id)?.state).toBe('pending')
  release?.(receipt(id))
  expect(await initial).toMatchObject({ state: 'restored', mutation: { replayed: false } })
  expect(await concurrent).toMatchObject({ mutation: { replayed: true } })
  expect(invoke).toHaveBeenCalledTimes(1)
  first.db.close()
  const reopened = ledger(filename)
  try {
    const noEffect = vi.fn()
    expect(
      await reopened.executor.run(request(id), payload(id), noEffect, 'caller-a')
    ).toMatchObject({ mutation: { replayed: true } })
    expect(noEffect).not.toHaveBeenCalled()
    await expect(
      reopened.executor.run(
        request(id),
        payload(id, { ...tuple, head: 'e'.repeat(40) }),
        noEffect,
        'caller-a'
      )
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    const dispatcher = new RpcDispatcher({
      runtime: reopened.runtime,
      methods: WORKTREE_MATERIAL_METHODS
    })
    const show: RpcRequest = {
      id: 'show',
      authToken: 'fixture-token',
      method: 'worktree.materialShow',
      params: { requestId: id }
    }
    const replies: string[] = []
    await dispatcher.dispatchStreaming(show, (reply) => replies.push(reply), {
      authenticatedCallerFingerprint: 'caller-a'
    })
    expect(replies.join('')).toContain('completed')
    expect(replies.join('')).not.toContain('fixture-token')
    const foreign: string[] = []
    await dispatcher.dispatchStreaming(show, (reply) => foreign.push(reply), {
      authenticatedCallerFingerprint: 'caller-b'
    })
    expect(foreign.join('')).toContain('absent')
    expect(foreign.join('')).not.toContain('payloadHash')
    expect(reopened.db.getMutationReceipt('caller-b', id)).toBeUndefined()
  } finally {
    reopened.db.close()
  }
})

it('retains UNKNOWN after possible material effects and restart, but preserves old method failure policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-material-unknown-'))
  paths.push(root)
  const filename = join(root, 'fixture.sqlite')
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const first = ledger(filename)
  const interrupted = (mutation?: DurableMutationInvocation) => {
    expect(first.db.getMutationReceipt('caller', id)?.state).toBe('pending')
    mutation?.markEffectPossible()
    throw new Error('synthetic timeout after possible effect')
  }
  await expect(
    first.executor.run(request(id), payload(id), interrupted, 'caller')
  ).rejects.toMatchObject({
    code: 'operation_unknown'
  })
  expect(first.db.getMutationReceipt('caller', id)?.state).toBe('pending')
  first.db.close()
  const reopened = ledger(filename)
  try {
    const noRetry = vi.fn()
    await expect(
      reopened.executor.run(request(id), payload(id), noRetry, 'caller')
    ).rejects.toMatchObject({
      code: 'operation_unknown'
    })
    expect(noRetry).not.toHaveBeenCalled()
    const legacy = (mutation?: DurableMutationInvocation) => {
      mutation?.markEffectPossible()
      throw new Error('legacy failure')
    }
    await expect(
      reopened.executor.run(request('legacy', 'orchestration.send'), {}, legacy, 'caller')
    ).rejects.toThrow('legacy failure')
    expect(reopened.db.getMutationReceipt('caller', 'legacy')).toBeUndefined()
    await expect(
      reopened.executor.run(
        request('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
        payload('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
          ...tuple,
          path: '/fixture/second',
          worktreeId: 'fixture::/fixture/second',
          branch: 'second'
        }),
        () => {
          throw new Error('before effect')
        },
        'caller'
      )
    ).rejects.toThrow('before effect')
    expect(
      reopened.db.getMutationReceipt('caller', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    ).toBeUndefined()
  } finally {
    reopened.db.close()
  }
})

it.each(['E_MATERIAL_CAS_CONFLICT', 'lifecycle_timeout'])(
  'releases a proved pre-effect %s durably, admitting a fresh legitimate attempt after reload',
  async (reason) => {
    const root = mkdtempSync(join(tmpdir(), 'material-refusal-'))
    paths.push(root)
    const filename = join(root, 'ledger.sqlite')
    const first = ledger(filename)
    const id = '12121212-1212-4212-8212-121212121212'
    const commits: unknown[] = []
    const exec = first.db.db.exec.bind(first.db.db)
    vi.spyOn(first.db.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') {
        commits.push(first.db.db.pragma('synchronous', { simple: true }))
      }
      return exec(sql)
    })
    await expect(
      first.executor.run(
        request(id),
        payload(id),
        () => {
          expect(first.db.getMutationReceipt('caller', id)?.state).toBe('pending')
          throw new Error(reason)
        },
        'caller'
      )
    ).rejects.toThrow(reason)
    expect(first.db.getMutationReceipt('caller', id)).toBeUndefined()
    expect(commits).toEqual([2, 2])
    expect(first.db.db.pragma('synchronous', { simple: true })).toBe(1)
    first.db.close()
    const next = ledger(filename)
    const fresh = '23232323-2323-4232-8232-232323232323'
    try {
      expect(next.db.getMutationReceipt('caller', id)).toBeUndefined()
      const invoke = vi.fn(() => receipt(fresh))
      await expect(
        next.executor.run(request(fresh), payload(fresh), invoke, 'caller')
      ).resolves.toMatchObject({ state: 'restored' })
      expect(invoke).toHaveBeenCalledOnce()
    } finally {
      next.db.close()
    }
  }
)

it('another request reservation is a known refusal with no own claim or invocation', async () => {
  const f = ledger()
  const original = '34343434-3434-4343-8343-343434343434'
  const other = '45454545-4545-4454-8454-454545454545'
  try {
    await expect(
      f.executor.run(
        request(original),
        payload(original),
        (mutation) => {
          mutation?.markEffectPossible()
          throw new Error('effect interrupted')
        },
        'caller'
      )
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    const before = f.db.getMutationReceipt('caller', original)
    const invoke = vi.fn()
    const error = await f.executor
      .run(request(other), payload(other), invoke, 'caller-b')
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'E_MATERIAL_TARGET_RESERVED' })
    expect(error).not.toMatchObject({ code: 'operation_unknown' })
    expect(f.db.getMutationReceipt('caller-b', other)).toBeUndefined()
    expect(f.db.getMutationReceipt('caller', original)).toEqual(before)
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    f.db.close()
  }
})

import {
  createSqliteTestStore,
  closeTestStores,
  readPersistedStateJson
} from '../../../persistence-test-harness'
import { Store } from '../../../persistence/loading-store/store'
import { hashCanonical } from '../../rpc/orchestration-mutation-receipt'
import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

it('retains full metadata durably before synthetic instance rotation; public projection excludes history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-material-lineage-'))
  paths.push(root)
  await mkdir(join(root, 'historical'))
  const dataFile = join(root, 'state.json')
  const id = `fixture::${root}/historical`
  const old: WorktreeMeta = {
    instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hostId: 'local',
    displayName: 'original',
    comment: 'original private annotation',
    linkedIssue: 413,
    linkedPR: 411,
    linkedLinearIssue: null,
    isArchived: true,
    isUnread: false,
    isPinned: true,
    sortOrder: 7,
    lastActivityAt: 42,
    baseRef: 'origin/old',
    workspaceStatus: 'complete'
  }
  const first = createSqliteTestStore(Store, { dataFile })
  try {
    first.addRepo({
      id: 'fixture',
      path: root,
      displayName: 'Fixture',
      badgeColor: '',
      addedAt: 1,
      executionHostId: 'local'
    })
    first.setWorktreeMeta(id, old)
    const actual = structuredClone(first.getWorktreeMeta(id))
    expect(actual).toBeDefined()
    if (!actual) {
      throw new Error('fixture metadata absent')
    }
    await first.runDurableMutation(() => ({
      value: first.stageMaterialHistory(
        {
          ...tuple,
          worktreeId: id,
          path: `${root}/historical`,
          historicalInstanceId: actual.instanceId!,
          expectedMetadataDigest: hashCanonical(actual)
        },
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      )
    }))
    await first.flushPendingOrThrowAsync({ fullCheckpoint: true })
    const persisted: {
      repos?: { id: string }[]
      worktreeMetaByIdentity?: Record<string, WorktreeMeta>
      worktreeMeta?: Record<string, WorktreeMeta>
    } = JSON.parse(readPersistedStateJson(dataFile))
    expect(persisted.repos?.map((repo) => repo.id)).toContain('fixture')
    expect(
      [
        ...Object.values(persisted.worktreeMetaByIdentity ?? {}),
        ...Object.values(persisted.worktreeMeta ?? {})
      ].some((meta) => meta.materialHistory?.metadataDigest === hashCanonical(actual))
    ).toBe(true)
    await closeTestStores()
    const reloaded = createSqliteTestStore(Store, { dataFile })
    expect(reloaded.getRepos().map((repo) => repo.id)).toContain('fixture')
    const saved = reloaded.getWorktreeMetaForHost(id, 'local')
    expect(saved?.instanceId).toBe(actual.instanceId)
    expect(saved?.materialHistory?.snapshot).toEqual(actual)
    expect(saved?.materialHistory?.metadataDigest).toBe(hashCanonical(actual))
    const next = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    reloaded.setWorktreeMeta(id, { instanceId: next })
    await reloaded.flushPendingOrThrowAsync({ fullCheckpoint: true })
    await closeTestStores()
    const rotated = createSqliteTestStore(Store, { dataFile }).getWorktreeMetaForHost(id, 'local')
    expect(rotated).toEqual({ ...saved, instanceId: next })
    expect(rotated?.materialHistory?.snapshot).toEqual(actual)
    const projection = mergeWorktree(
      'fixture',
      {
        path: `${root}/historical`,
        branch: 'refs/heads/old',
        head: 'a'.repeat(40),
        isBare: false,
        isMainWorktree: false
      },
      rotated
    )
    expect(projection).not.toHaveProperty('materialHistory')
  } finally {
    await closeTestStores()
  }
})

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { gitExecFileAsync } from '../../../git/runner'

it.each(['mkdir', 'checkout', 'complete'])(
  'owned temporary Git + real ledger: %s boundary survives restart without second Git write',
  async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-material-crash-'))
    paths.push(root)
    const repo = join(root, 'repo')
    const target = join(root, 'historical')
    await mkdir(repo)
    const config = join(root, 'empty-config')
    await writeFile(config, '')
    const git = async (...args: string[]) =>
      (
        await gitExecFileAsync(args, {
          cwd: repo,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
            GIT_CONFIG_SYSTEM: config,
            GIT_OPTIONAL_LOCKS: '0'
          }
        })
      ).stdout.trim()
    await git('init', '--quiet')
    await git('config', 'user.name', 'Fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(repo, 'file.txt'), 'original\n')
    await git('add', 'file.txt')
    await git('commit', '--quiet', '-m', 'base')
    await git('worktree', 'add', '-b', 'historical', target)
    const admin = (await readFile(join(target, '.git'), 'utf8')).trim().slice(8)
    const index = await readFile(join(admin, 'index'))
    const head = await git('rev-parse', 'historical')
    const exact = {
      ...tuple,
      path: target,
      worktreeId: `fixture::${target}`,
      branch: 'historical',
      head,
      tree: await git('rev-parse', 'historical^{tree}')
    }
    await rm(target, { recursive: true })
    const filename = join(root, 'receipt.sqlite')
    const first = ledger(filename)
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    let gitWrites = 0
    const materialize = async (mutation?: DurableMutationInvocation) => {
      expect(first.db.getMutationReceipt('caller', id)?.state).toBe('pending')
      expect(mutation?.identity.requestId).toBe(id)
      mutation?.markEffectPossible()
      await mkdir(target)
      if (phase === 'mkdir') {
        throw new Error('synthetic crash after mkdir')
      }
      // Existing restoreMissingWorktreeGitFile accepts EEXIST; this fixture requires exclusive creation.
      await writeFile(join(target, '.git'), `gitdir: ${admin}\n`, { flag: 'wx' })
      gitWrites += 1
      await git(`--git-dir=${admin}`, `--work-tree=${target}`, 'checkout-index', '--all')
      expect(await readFile(join(admin, 'index'))).toEqual(index)
      expect(await git('rev-parse', 'historical')).toBe(head)
      if (phase === 'checkout') {
        throw new Error('synthetic crash after materialization')
      }
      expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('original\n')
      return receipt(id, exact)
    }
    const check = expect(first.executor.run(request(id), payload(id, exact), materialize, 'caller'))
    await (phase === 'complete'
      ? check.resolves.toMatchObject({ state: 'restored' })
      : check.rejects.toMatchObject({ code: 'operation_unknown' }))
    first.db.close()
    const reopened = ledger(filename)
    try {
      const noRetry = vi.fn()
      const replay = expect(
        reopened.executor.run(request(id), payload(id, exact), noRetry, 'caller')
      )
      await (phase === 'complete'
        ? replay.resolves.toMatchObject({ mutation: { replayed: true } })
        : replay.rejects.toMatchObject({ code: 'operation_unknown' }))
      expect(noRetry).not.toHaveBeenCalled()
      expect(gitWrites).toBe(phase === 'mkdir' ? 0 : 1)
    } finally {
      reopened.db.close()
    }
  }
)

it('concurrent material callers both receive UNKNOWN after the same possible effect', async () => {
  const harness = ledger()
  let reject: ((error: Error) => void) | undefined
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  try {
    const invoke = vi.fn((mutation?: DurableMutationInvocation) => {
      mutation?.markEffectPossible()
      return new Promise((_resolve, fail) => {
        reject = fail
      })
    })
    const first = harness.executor.run(request(id), payload(id), invoke, 'caller')
    await Promise.resolve()
    const second = harness.executor.run(request(id), payload(id), invoke, 'caller')
    const firstCheck = expect(first).rejects.toMatchObject({ code: 'operation_unknown' })
    const secondCheck = expect(second).rejects.toMatchObject({ code: 'operation_unknown' })
    reject?.(new Error('synthetic effect timeout'))
    await Promise.all([firstCheck, secondCheck])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(harness.db.getMutationReceipt('caller', id)?.state).toBe('pending')
  } finally {
    harness.db.close()
  }
})

it('failed durable cleanup and a claim found at BEGIN remain UNKNOWN without clearing history', async () => {
  const f = ledger()
  const id = '56565656-5656-4565-8565-565656565656'
  const cleanup = vi.spyOn(f.db, 'discardEffectFreeMaterialClaim').mockImplementation(() => {
    throw new Error('commit failed')
  })
  try {
    await expect(
      f.executor.run(
        request(id),
        payload(id),
        () => {
          throw new Error('pre-effect')
        },
        'caller'
      )
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(f.db.getMutationReceipt('caller', id)?.state).toBe('pending')
    cleanup.mockRestore()
    const anotherRuntime = ledger()
    try {
      const begin = anotherRuntime.db.beginMutationReceipt.bind(anotherRuntime.db)
      vi.spyOn(anotherRuntime.db, 'beginMutationReceipt').mockImplementation((params) => {
        begin(params)
        return begin(params)
      })
      const invoke = vi.fn()
      await expect(
        anotherRuntime.executor.run(request(id), payload(id), invoke, 'caller')
      ).rejects.toMatchObject({ code: 'operation_unknown' })
      expect(invoke).not.toHaveBeenCalled()
      expect(anotherRuntime.db.getMutationReceipt('caller', id)?.state).toBe('pending')
    } finally {
      anotherRuntime.db.close()
    }
  } finally {
    cleanup.mockRestore()
    f.db.close()
  }
})

it.each(['before', 'after'])(
  'unary material handler through streaming preserves the %s-effect boundary',
  async (phase) => {
    const f = ledger()
    const id = '67676767-6767-4676-8676-676767676767'
    const root = mkdtempSync(join(tmpdir(), 'material-streaming-'))
    paths.push(root)
    const target = join(root, 'created')
    const restore = vi
      .spyOn(f.runtime, 'restoreMaterial')
      .mockImplementation(async (_manifest, requestId, mark) => {
        expect(requestId).toBe(id)
        expect(f.db.getMutationReceipt('caller', id)?.state).toBe('pending')
        expect(typeof mark).toBe('function')
        if (phase === 'before') {
          throw new Error('E_MATERIAL_CAS_CONFLICT')
        }
        mark()
        await mkdir(target)
        throw new Error('interrupted after mkdir')
      })
    const dispatcher = new RpcDispatcher({ runtime: f.runtime, methods: WORKTREE_MATERIAL_METHODS })
    const replies: string[] = []
    try {
      await dispatcher.dispatchStreaming(
        { ...request(id), params: payload(id) },
        (reply) => replies.push(reply),
        {
          authenticatedCallerFingerprint: 'caller'
        }
      )
      expect(restore).toHaveBeenCalledOnce()
      expect(replies.join('')).toContain(
        phase === 'before' ? 'E_MATERIAL_CAS_CONFLICT' : 'operation_unknown'
      )
      expect(f.db.getMutationReceipt('caller', id)?.state).toBe(
        phase === 'before' ? undefined : 'pending'
      )
      if (phase === 'after') {
        await dispatcher.dispatchStreaming({ ...request(id), params: payload(id) }, () => {}, {
          authenticatedCallerFingerprint: 'caller'
        })
        expect(restore).toHaveBeenCalledOnce()
      }
    } finally {
      restore.mockRestore()
      f.db.close()
    }
  }
)

it('a BEGIN failure after durable commit is UNKNOWN and cannot discard the committed claim', async () => {
  const f = ledger()
  const id = '78787878-7878-4787-8787-787878787878'
  const begin = f.db.beginMutationReceipt.bind(f.db)
  vi.spyOn(f.db, 'beginMutationReceipt').mockImplementation((params) => {
    begin(params)
    throw new Error('failed to restore connection setting after COMMIT')
  })
  const cleanup = vi.spyOn(f.db, 'discardEffectFreeMaterialClaim')
  const invoke = vi.fn()
  try {
    await expect(f.executor.run(request(id), payload(id), invoke, 'caller')).rejects.toMatchObject({
      code: 'operation_unknown'
    })
    expect(f.db.getMutationReceipt('caller', id)?.state).toBe('pending')
    expect(invoke).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
  } finally {
    f.db.close()
  }
})
