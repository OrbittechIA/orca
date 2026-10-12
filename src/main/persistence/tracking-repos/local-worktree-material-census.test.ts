import { expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { captureLocalWorktreeMaterialCensus } from './local-worktree-material-census'

const targetId = 'repo::/fixture/missing'
const meta: WorktreeMeta = {
  instanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  hostId: 'local',
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
const key = canonicalWorktreeIdentity({
  worktreeId: targetId,
  executionHostId: 'local',
  instanceId: meta.instanceId!
})
function fixture() {
  const state = getDefaultPersistedState('/synthetic-profile')
  state.worktreeMeta = { [targetId]: structuredClone(meta) }
  state.worktreeMetaByIdentity = { [key]: structuredClone(meta) }
  state.worktreeIdentityAliases = { [`local|${targetId}`]: [key] }
  return state
}

it('captures all rows without mutation and ignores unrelated UI drift in the ownership CAS', () => {
  const state = fixture()
  state.worktreeMeta['neighbor::/fixture/neighbor'] = { ...meta, instanceId: 'other' }
  const before = structuredClone(state)
  const census = captureLocalWorktreeMaterialCensus(state, targetId)
  expect(census.complete).toBe(true)
  expect(state).toEqual(before)
  state.worktreeMeta['neighbor::/fixture/neighbor'].comment = 'UI edit'
  expect(captureLocalWorktreeMaterialCensus(state, targetId).ownershipDigest).toBe(
    census.ownershipDigest
  )
  state.worktreeMeta['neighbor::/fixture/neighbor'].instanceId = 'reused'
  expect(captureLocalWorktreeMaterialCensus(state, targetId).ownershipDigest).not.toBe(
    census.ownershipDigest
  )
})

it('does not infer another repo from an orphan wt2 host/instance', () => {
  const state = fixture()
  state.worktreeMetaByIdentity!['wt2:local:orphan'] = { ...meta, instanceId: 'orphan' }
  expect(captureLocalWorktreeMaterialCensus(state, targetId)).toMatchObject({
    complete: false,
    reason: 'opaque'
  })
})

it('refuses competing aliases, unknown host rows, dangling aliases and bounded overflows', () => {
  const state = fixture()
  state.worktreeIdentityAliases![`local|${targetId}`].push('wt2:local:other')
  expect(captureLocalWorktreeMaterialCensus(state, targetId).complete).toBe(false)
  const unknown = fixture()
  delete unknown.worktreeMeta[targetId].hostId
  expect(captureLocalWorktreeMaterialCensus(unknown, targetId).complete).toBe(false)
  const large = fixture()
  large.worktreeMeta[targetId].comment = 'x'.repeat(131_073)
  expect(captureLocalWorktreeMaterialCensus(large, targetId)).toMatchObject({
    complete: false,
    reason: 'limit'
  })
})
