import { afterEach, expect, it, vi } from 'vitest'
import {
  planWorktreeMaterial,
  observeMaterialProcessAbsence,
  type MaterialAuthority
} from './runtime-worktree-material'
import {
  WorktreeMaterialManifest,
  WorktreeMaterialRestore
} from '../../shared/rpc-contract/worktree-material-params'
import * as git from './runtime-worktree-material-git'

const manifest = WorktreeMaterialManifest.parse({
  schemaVersion: 1,
  repo: 'id:repo',
  canonicalSource: 'example.org/team/repo',
  executionHostId: 'local',
  worktreeId: 'repo::/fixture/missing',
  path: '/fixture/missing',
  branch: 'old',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  linkedIssue: 413,
  linkedReview: 411,
  historicalInstanceId: null,
  runId: 'old',
  capsuleSHA256: 'c'.repeat(64),
  expectedMetadataDigest: 'd'.repeat(64)
})

it('strict schemas require full restore tuple and explicit UUID; never accepts bypass flags', () => {
  expect(WorktreeMaterialManifest.safeParse({ ...manifest, force: true }).success).toBe(false)
  expect(WorktreeMaterialRestore.safeParse({ manifest }).success).toBe(false)
  expect(
    WorktreeMaterialRestore.safeParse({
      manifest,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).success
  ).toBe(false)
  expect(
    WorktreeMaterialManifest.safeParse({
      ...manifest,
      canonicalSource: 'https://user:password@example.org/team/repo'
    }).success
  ).toBe(false)
})

it.each(['ssh:host', 'runtime:host', 'unknown'])(
  'refuses %s before using local filesystem as proof',
  async (executionHostId) => {
    const inspect = vi.spyOn(git, 'inspectMaterialGit')
    const repos = [
      { id: 'repo', path: '/fixture/repo', displayName: '', badgeColor: '', addedAt: 1 }
    ]
    expect(
      await planWorktreeMaterial({ repos, snapshot: null }, { ...manifest, executionHostId })
    ).toMatchObject({ code: 'E_MATERIAL_HOST_UNSUPPORTED', wouldWrite: false })
    expect(inspect).not.toHaveBeenCalled()
    inspect.mockRestore()
  }
)

it('folder and missing metadata stay unverifiable with no create or liveness claim', async () => {
  const repo = { id: 'repo', path: '/fixture/repo', displayName: '', badgeColor: '', addedAt: 1 }
  expect(
    (await planWorktreeMaterial({ repos: [{ ...repo, kind: 'folder' }], snapshot: null }, manifest))
      .code
  ).toBe('E_MATERIAL_HOST_UNSUPPORTED')
  expect(await planWorktreeMaterial({ repos: [repo], snapshot: null }, manifest)).toMatchObject({
    code: 'E_MATERIAL_METADATA_UNVERIFIABLE',
    coverage: { git: false, processes: 'unverifiable' }
  })
})

import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { getDefaultPersistedState } from '../../shared/constants'
import { captureLocalWorktreeMaterialCensus } from '../persistence/tracking-repos/local-worktree-material-census'
import * as probes from './structured-agent-session-owner-probe'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

afterEach(() => vi.restoreAllMocks())
function processFixture() {
  const record = agentSessionRecordFixture()
  record.location.workspaceId = 'repo::/fixture/neighbor'
  record.launchDirectory = '/fixture/neighbor'
  const state = getDefaultPersistedState('/fixture/profile')
  const metadata: WorktreeMeta = {
    hostId: 'local',
    instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    displayName: '',
    comment: '',
    linkedIssue: 413,
    linkedPR: 411,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
  state.worktreeMeta[manifest.worktreeId] = metadata
  state.worktreeMeta[record.location.workspaceId] = {
    ...metadata,
    instanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  }
  const records = [record],
    held = [record.sessionId]
  const store = {
    hostId: 'local',
    readOnly: false,
    listRecords: () => records,
    listHeldSessionIds: () => held
  }
  const authority: MaterialAuthority = {
    repos: [],
    census: captureLocalWorktreeMaterialCensus(state, manifest.worktreeId),
    peekStructured: () => store,
    observePty: async () => ({ state: 'complete', processes: [], stillCurrent: () => true })
  }
  return { record, records, held, store, authority }
}

it('requires exact unique structured inventory and never probes a malformed record', async () => {
  const f = processFixture()
  f.records.push(f.record)
  f.held.push('missing-record')
  const probe = vi.spyOn(probes, 'createStructuredAgentSessionOwnerProbe')
  await expect(observeMaterialProcessAbsence(f.authority, manifest)).rejects.toThrow(
    'census_incomplete'
  )
  expect(probe).not.toHaveBeenCalled()
})

it('validates neighboring identity and rejects foreign or WSL namespaces without native PID guessing', async () => {
  const f = processFixture()
  const probe = vi.fn(async () => ({
    outcome: 'identity-matched' as const,
    matchedOn: ['spawn-token' as const]
  }))
  vi.spyOn(probes, 'createStructuredAgentSessionOwnerProbe').mockReturnValue(probe)
  const current = await observeMaterialProcessAbsence(f.authority, manifest)
  expect(current?.()).toBe(true)
  expect(probe).toHaveBeenCalledOnce()
  f.record.location.wslDistro = 'Ubuntu'
  expect(await observeMaterialProcessAbsence(f.authority, manifest)).toBeNull()
  expect(probe).toHaveBeenCalledOnce()
})

it('does not certify an indeterminate neighboring owner; provider-chain drift invalidates the snapshot', async () => {
  const f = processFixture()
  vi.spyOn(probes, 'createStructuredAgentSessionOwnerProbe').mockReturnValue(async () => ({
    outcome: 'indeterminate',
    reason: 'unknown host'
  }))
  expect(await observeMaterialProcessAbsence(f.authority, manifest)).toBeNull()
  vi.mocked(probes.createStructuredAgentSessionOwnerProbe).mockReturnValue(async () => ({
    outcome: 'reservation-unused'
  }))
  const current = await observeMaterialProcessAbsence(f.authority, manifest)
  expect(current?.()).toBe(true)
  f.record.providerHandleChain[0].mintedAtFence++
  expect(current?.()).toBe(false)
})

import { isAgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { PtyProcessInfo } from '../providers/pty-process-info'
it('binds PTY owner to the process locator, checks physical aliases, and accepts unrelated custom cwd', async () => {
  const f = processFixture()
  f.records.splice(0)
  f.held.splice(0)
  const id = f.record.location.workspaceId
  const owner = {
    claim: {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'i'.repeat(43),
      worktreeScopeDigest: 'w'.repeat(43),
      agent: 'claude' as const
    },
    generation: 'generation',
    phase: 'live' as const,
    ptyId: 'pty',
    surface: {
      worktreeId: id,
      tabId: 'tab',
      leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      terminalHandle: 'term_fixture'
    }
  }
  expect(isAgentSessionOwnerBinding(owner)).toBe(true)
  const process: PtyProcessInfo = {
    id: 'pty',
    incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    rootProcessId: 4242,
    cwd: '/fixture/custom-cwd',
    title: '',
    worktreeId: id,
    wslDistro: null,
    agentSessionOwners: [owner]
  }
  f.authority.observePty = async () => ({
    state: 'complete',
    processes: [process],
    stillCurrent: () => true
  })
  expect((await observeMaterialProcessAbsence(f.authority, manifest))?.()).toBe(true)
  owner.surface.worktreeId = manifest.worktreeId
  expect(await observeMaterialProcessAbsence(f.authority, manifest)).toBeNull()
  owner.surface.worktreeId = id
  process.cwd = manifest.path
  expect(await observeMaterialProcessAbsence(f.authority, manifest)).toBeNull()
  process.cwd = '/fixture/custom-cwd'
  const alias = `other-repo::${manifest.path}`
  const row = f.authority.census!.rows.find((row) => row.worktreeId === id)!
  f.authority.census!.rows.push({ ...row, key: `legacy:${alias}`, worktreeId: alias })
  process.worktreeId = alias
  owner.surface.worktreeId = alias
  expect(await observeMaterialProcessAbsence(f.authority, manifest)).toBeNull()
})
