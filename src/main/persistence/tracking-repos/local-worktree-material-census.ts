import {
  materialHistoryDigest as hashCanonical,
  type MaterialMetadataCensus,
  type MaterialManifest,
  type MaterialHistoryAssertion
} from '../../../shared/worktree/material-types'
import {
  assertMaterialHistoryDomains,
  validRetainedHistory
} from '../loading-store/profile-state-authority'
import { randomUUID } from 'node:crypto'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'

type CensusState = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

export type {
  MaterialMetadataRow,
  MaterialMetadataCensus
} from '../../../shared/worktree/material-types'
/** Captures all three maps without invoking migrating getters or choosing an alias winner. */
export function captureLocalWorktreeMaterialCensus(
  state: CensusState,
  targetId: string
): MaterialMetadataCensus {
  const result: MaterialMetadataCensus = {
    complete: false,
    reason: 'opaque',
    rows: [],
    metadata: null,
    metadataDigest: null,
    ownershipDigest: null
  }
  const legacy = Object.entries(state.worktreeMeta)
  const canonical = Object.entries(state.worktreeMetaByIdentity ?? {})
  const aliases = Object.entries(state.worktreeIdentityAliases ?? {})
  if (legacy.length + canonical.length + aliases.length > 20_000) {
    result.reason = 'limit'
    return result
  }
  let bytes = 0
  let opaque = false
  let collision = false
  const locations = new Map<string, Set<string>>()
  try {
    for (const [alias, keys] of aliases) {
      const hostId = getExecutionHostIdFromWorktreeHostIdentity(alias)
      const worktreeId = getWorktreeIdFromHostIdentity(alias)
      if (!hostId || !splitWorktreeId(worktreeId) || !Array.isArray(keys) || keys.length > 64) {
        opaque = true
        continue
      }
      bytes += Buffer.byteLength(JSON.stringify([alias, keys]))
      if (new Set(keys).size !== keys.length || keys.length > 1) {
        collision = true
      }
      for (const key of keys) {
        const meta = state.worktreeMetaByIdentity?.[key]
        if (!meta || meta.hostId !== hostId) {
          opaque = true
        }
        const locators = locations.get(key) ?? new Set<string>()
        locators.add(worktreeId)
        locations.set(key, locators)
      }
    }
    const copyRow = (key: string, worktreeId: string | null, meta: WorktreeMeta) => {
      const serialized = JSON.stringify(meta)
      bytes += Buffer.byteLength(serialized)
      if (bytes > 8 * 1024 * 1024 || serialized.length > 131_072) {
        throw new Error('limit')
      }
      if (!parseExecutionHostId(meta.hostId) || !worktreeId || !splitWorktreeId(worktreeId)) {
        opaque = true
      }
      result.rows.push({
        key,
        worktreeId,
        hostId: meta.hostId ?? null,
        instanceId: meta.instanceId ?? null,
        metadata: structuredClone(meta)
      })
    }
    for (const [worktreeId, meta] of legacy) {
      copyRow(`legacy:${worktreeId}`, worktreeId, meta)
      if (meta.hostId && meta.instanceId) {
        const key = canonicalWorktreeIdentity({
          worktreeId,
          executionHostId: meta.hostId,
          instanceId: meta.instanceId
        })
        const locators = locations.get(key) ?? new Set<string>()
        locators.add(worktreeId)
        locations.set(key, locators)
        if (locators.size > 1) {
          collision = true
        }
      }
    }
    for (const [key, meta] of canonical) {
      if (
        !meta.hostId ||
        !meta.instanceId ||
        canonicalWorktreeIdentity({
          worktreeId: '',
          executionHostId: meta.hostId,
          instanceId: meta.instanceId
        }) !== key
      ) {
        opaque = true
      }
      const located = locations.get(key) ?? new Set<string>()
      if (located.size > 1) {
        collision = true
      }
      const retained =
        located.size === 0 &&
        meta.materialHistory?.historicalInstanceId === meta.instanceId &&
        validRetainedHistory(meta)
      copyRow(
        key,
        located.size === 1 ? [...located][0] : retained ? meta.materialHistory!.worktreeId! : null,
        meta
      )
      if (retained) {
        result.rows.at(-1)!.retained = true
      }
    }
    if (bytes > 8 * 1024 * 1024) {
      throw new Error('limit')
    }
  } catch {
    result.reason = 'limit'
    return result
  }
  const target = result.rows.filter(
    (row) => row.worktreeId === targetId && row.hostId === 'local' && !row.retained
  )
  const digests = new Set(target.map((row) => hashCanonical(row.metadata)))
  if (digests.size > 1) {
    collision = true
  }
  if (!opaque && !collision && target.length) {
    result.metadata = target[0].metadata
    result.metadataDigest = hashCanonical(result.metadata)
  }
  result.reason = collision ? 'collision' : opaque ? 'opaque' : 'complete'
  result.complete = result.reason === 'complete'
  result.ownershipDigest = result.complete
    ? hashCanonical({
        aliases: aliases.sort(([a], [b]) => a.localeCompare(b)),
        rows: result.rows
          .map(({ key, worktreeId, hostId, instanceId }) => ({
            key,
            worktreeId,
            hostId,
            instanceId
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        metadataDigest: result.metadataDigest
      })
    : null
  return result
}

export function stageMaterialHistoryState(
  state: CensusState,
  manifest: MaterialManifest,
  requestId: string
): MaterialHistoryAssertion {
  const census = captureLocalWorktreeMaterialCensus(state, manifest.worktreeId)
  const meta = census.metadata
  if (
    !census.complete ||
    !meta ||
    census.metadataDigest !== manifest.expectedMetadataDigest ||
    !meta.instanceId ||
    meta.materialHistory ||
    Buffer.byteLength(JSON.stringify(meta)) > 65_536
  ) {
    throw new Error('E_MATERIAL_METADATA_CONFLICT')
  }
  const rows = census.rows.filter(
    (row) => row.worktreeId === manifest.worktreeId && row.hostId === 'local'
  )
  const canonicalKeys = rows.filter((row) => !row.key.startsWith('legacy:')).map((row) => row.key)
  const aliases = Object.fromEntries(
    Object.entries(state.worktreeIdentityAliases ?? {}).filter(([, keys]) =>
      keys.some((key) => canonicalKeys.includes(key))
    )
  )
  const history: NonNullable<WorktreeMeta['materialHistory']> = {
    schemaVersion: 1,
    worktreeId: manifest.worktreeId,
    requestId,
    historicalInstanceId: meta.instanceId ?? null,
    metadataDigest: manifest.expectedMetadataDigest,
    snapshot: structuredClone(meta),
    representations: {
      legacy: Object.hasOwn(state.worktreeMeta, manifest.worktreeId),
      canonicalKeys,
      aliases: structuredClone(aliases)
    }
  }
  const retained = { ...meta, materialHistory: history }
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  if (history.representations?.legacy) {
    state.worktreeMeta[manifest.worktreeId] = retained
  }
  for (const key of canonicalKeys) {
    state.worktreeMetaByIdentity[key] = retained
  }
  state.worktreeMetaByIdentity[
    canonicalWorktreeIdentity({
      worktreeId: manifest.worktreeId,
      executionHostId: 'local',
      instanceId: meta.instanceId
    })
  ] = retained
  return {
    schemaVersion: 1,
    executionHostId: 'local',
    worktreeId: manifest.worktreeId,
    historicalInstanceId: meta.instanceId ?? null,
    requestId,
    metadataDigest: manifest.expectedMetadataDigest,
    historyDigest: hashCanonical(history)
  }
}

export function publishMaterialIdentityState(
  state: CensusState,
  expected: MaterialHistoryAssertion
): string {
  assertMaterialHistoryDomains(
    new Map<string, unknown>([
      ['worktreeMeta', state.worktreeMeta],
      ['worktreeMetaByIdentity', state.worktreeMetaByIdentity ?? {}],
      ['worktreeIdentityAliases', state.worktreeIdentityAliases ?? {}]
    ]),
    expected
  )
  const rows = captureLocalWorktreeMaterialCensus(state, expected.worktreeId)
  const history = rows.metadata?.materialHistory
  if (
    !rows.complete ||
    !rows.metadata ||
    !history ||
    hashCanonical(rows.metadata) !==
      hashCanonical({ ...history.snapshot, materialHistory: history }) ||
    (rows.metadata.instanceId ?? null) !== expected.historicalInstanceId
  ) {
    throw new Error('E_MATERIAL_METADATA_CONFLICT')
  }
  const instanceId = randomUUID()
  const {
    automationProvenance: _automation,
    cliProvenance: _cli,
    linkedTaskSourceContext: _task,
    materialHistory: _history,
    ...meta
  } = rows.metadata
  const next = { ...meta, instanceId }
  const key = canonicalWorktreeIdentity({
    worktreeId: expected.worktreeId,
    executionHostId: 'local',
    instanceId
  })
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  state.worktreeMetaByIdentity[key] = next
  state.worktreeIdentityAliases[`local|${expected.worktreeId}`] = [key]
  state.worktreeMeta[expected.worktreeId] = next
  return instanceId
}
