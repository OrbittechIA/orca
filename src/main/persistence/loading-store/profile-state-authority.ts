import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type Database from '../../sqlite/sync-database'
import { withProfileStateReadSnapshot } from '../profile-state/profile-state-read-snapshot'
import { isRecord } from '../profile-state/profile-state-document-validation'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { materialHistoryDigest as hashCanonical } from '../../../shared/worktree/material-types'
import { MaterialHistoryAssertionSchema } from '../../../shared/rpc-contract/worktree-material-params'
import type { ProfileStateDomainsReadResult } from '../profile-state/profile-state-domain-reader'
import type { MaterialHistoryAssertion } from '../../../shared/worktree/material-types'
import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { AutomationRun } from '../../../shared/automations-types'
import type { ProfileStateDatabaseQuarantine } from '../profile-state/profile-state-database-quarantine'

export type ProfileStateMaintenance = {
  /** Re-admit the unchanged profile before permitting any new persistence work. */
  resume(): Promise<void>
}

/** Keep offline/compatibility persistence loadable without eagerly importing SQLite. */
export type ProfileStateAuthority = {
  readonly asynchronous?: false
  assertMaterialHistory?: (expected: MaterialHistoryAssertion) => void
  /** Return storage-form JSON, or undefined when this authority has no state yet. */
  readSerializedState(): string | undefined

  /** Fence a hash-identical checkpoint without rereading or rewriting its payload. */
  assertCurrentRevision?: () => void

  /**
   * Optionally commit only the explicitly dirty top-level domains. Authorities
   * without this capability retain the complete-document fallback below.
   */
  writeSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  /**
   * Commit automation definition replacements and the changed run projection
   * in one profile-revision transaction without serializing unrelated domains.
   */
  writeSerializedAutomationRuns?: (
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ) => void

  /**
   * Durably replace the complete storage-form document. Implementations may
   * reject a stale read instead of allowing last-writer-wins replacement.
   */
  writeSerializedState(payload: Buffer): void

  /** Replace the whole profile; omitted domains and null payloads are deleted. */
  writeCompleteSerializedDomains?: (replacements: readonly ProfileStateDomainReplacement[]) => void

  /** Schedule bounded recovery protection after a successful primary commit. */
  scheduleBackup?: () => void

  /** Drain owned backup handles before shutdown or profile file mutations. */
  drainBackups?: (cancel?: boolean) => Promise<void>

  /** Optionally publish a durable JSON export for rollback or a compatibility runtime. */
  writeJsonExport?: (targetPath: string) => number

  /** Optionally preserve the database family before an explicit recovery decision. */
  quarantineDatabase?: (quarantineRoot?: string, reason?: string) => ProfileStateDatabaseQuarantine

  /** Release any process-local database handle before a profile is switched or removed. */
  close?: () => void

  /** Only a clean maintenance close may provide an explicit resume capability. */
  pauseForMaintenance?: () => Promise<ProfileStateMaintenance>
}

export type AsyncProfileStateAuthority = Omit<
  ProfileStateAuthority,
  | 'asynchronous'
  | 'assertCurrentRevision'
  | 'assertMaterialHistory'
  | 'writeSerializedDomains'
  | 'writeSerializedAutomationRuns'
  | 'writeSerializedState'
  | 'writeCompleteSerializedDomains'
  | 'writeJsonExport'
  | 'quarantineDatabase'
  | 'close'
> & {
  readonly asynchronous: true
  assertMaterialHistory?: (expected: MaterialHistoryAssertion) => Promise<void>
  assertWritable(): void
  abort(): Promise<void>
  assertCurrentRevision(): Promise<void>
  writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]): Promise<void>
  writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ): Promise<void>
  writeSerializedState(payload: Buffer): Promise<void>
  writeCompleteSerializedDomains(
    replacements: readonly ProfileStateDomainReplacement[]
  ): Promise<void>
  writeJsonExport(targetPath: string): Promise<number>
  writeLatestJsonExport(dataFile: string): Promise<number | undefined>
  quarantineDatabase(
    quarantineRoot?: string,
    reason?: string
  ): Promise<ProfileStateDatabaseQuarantine>
  close(): Promise<void>
}

export type ProfileStatePersistenceAuthority = ProfileStateAuthority | AsyncProfileStateAuthority

export type ProfileStateDomainReplacement = {
  domain: string
  /** Storage-form JSON for the domain, or null to remove its row. */
  payload: string | null
}

export type ProfileStateStartupPaneAlias = Omit<LegacyPaneKeyAliasEntry, 'ptyId'>

/** A startup read paired with the authority that observed its revision. */
export type ProfileStateAuthorityInitialState<
  Authority extends ProfileStatePersistenceAuthority = ProfileStateAuthority
> = {
  readonly authority: Authority
  readonly unboundPaneAliases?: readonly ProfileStateStartupPaneAlias[]
} & (
  | { readonly serializedState: string | undefined; readonly takeParsedState?: never }
  | {
      readonly serializedState?: never
      /** Transfer this storage-form object once, before the loader can decrypt or mutate it. */
      readonly takeParsedState: () => Record<string, unknown> | undefined
    }
)

/** A bounded assertion only: no profile payload is returned to the caller. */
export function assertMaterialHistoryDomains(
  values: ReadonlyMap<string, unknown>,
  expected: MaterialHistoryAssertion
): void {
  const legacy = values.get('worktreeMeta')
  const canonical = values.get('worktreeMetaByIdentity')
  const aliases = values.get('worktreeIdentityAliases')
  if (
    !isRecord(legacy) ||
    !isRecord(canonical) ||
    !isRecord(aliases) ||
    Object.keys(legacy).length + Object.keys(canonical).length + Object.keys(aliases).length >
      20_000
  ) {
    throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
  }
  if (!expected.historicalInstanceId) {
    throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
  }
  const oldKey = canonicalWorktreeIdentity({
    worktreeId: expected.worktreeId,
    executionHostId: 'local',
    instanceId: expected.historicalInstanceId
  })
  const oldProjection = aliases[`local|${expected.worktreeId}`]
  const archived =
    canonical[oldKey] ??
    (Array.isArray(oldProjection) && hashCanonical(oldProjection) === hashCanonical([oldKey])
      ? legacy[expected.worktreeId]
      : undefined)
  if (
    !isRecord(archived) ||
    !isRecord(archived.materialHistory) ||
    hashCanonical(archived.materialHistory) !== expected.historyDigest
  ) {
    throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
  }
  const candidates = [legacy[expected.worktreeId], ...Object.values(canonical)].filter(
    (row) =>
      isRecord(row) &&
      isRecord(row.materialHistory) &&
      row.materialHistory.worktreeId === expected.worktreeId
  )
  if (!candidates.length) {
    throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
  }
  for (const row of candidates) {
    if (!isRecord(row) || !isRecord(row.materialHistory)) {
      throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
    }
    const history = row.materialHistory
    const original = history.representations
    if (
      history.schemaVersion !== 1 ||
      history.requestId !== expected.requestId ||
      history.historicalInstanceId !== expected.historicalInstanceId ||
      history.metadataDigest !== expected.metadataDigest ||
      !isRecord(history.snapshot) ||
      history.snapshot.hostId !== expected.executionHostId ||
      (history.snapshot.instanceId ?? null) !== expected.historicalInstanceId ||
      Buffer.byteLength(JSON.stringify(history.snapshot)) > 65_536 ||
      hashCanonical(history.snapshot) !== expected.metadataDigest ||
      hashCanonical(history) !== expected.historyDigest ||
      !isRecord(original) ||
      !isRecord(original.aliases) ||
      !Array.isArray(original.canonicalKeys) ||
      typeof original.legacy !== 'boolean'
    ) {
      throw new Error('E_MATERIAL_HISTORY_CONFLICT')
    }
    const legacyRow = legacy[expected.worktreeId]
    if (
      original.legacy &&
      (!isRecord(legacyRow) || hashCanonical(legacyRow.materialHistory) !== expected.historyDigest)
    ) {
      throw new Error('E_MATERIAL_HISTORY_CONFLICT')
    }
    for (const [alias, keys] of Object.entries(original.aliases)) {
      if (hashCanonical(aliases[alias]) !== hashCanonical(keys)) {
        throw new Error('E_MATERIAL_HISTORY_CONFLICT')
      }
    }
    for (const key of original.canonicalKeys) {
      if (typeof key !== 'string') {
        throw new Error('E_MATERIAL_HISTORY_CONFLICT')
      }
      const projected =
        Array.isArray(aliases[`local|${expected.worktreeId}`]) &&
        hashCanonical(aliases[`local|${expected.worktreeId}`]) === hashCanonical([key])
      const stored = canonical[key] ?? (projected ? legacy[expected.worktreeId] : undefined)
      if (
        !isRecord(stored) ||
        stored.hostId !== 'local' ||
        typeof stored.instanceId !== 'string' ||
        key !==
          canonicalWorktreeIdentity({
            worktreeId: expected.worktreeId,
            executionHostId: 'local',
            instanceId: stored.instanceId
          }) ||
        hashCanonical(stored.materialHistory) !== expected.historyDigest
      ) {
        throw new Error('E_MATERIAL_HISTORY_CONFLICT')
      }
    }
  }
}

/** Called inside the existing writer transaction; callbacks expose only the three bounded domains. */
export function assertMaterialHistoryReadback(
  expected: MaterialHistoryAssertion,
  revision: number,
  sizes: () => readonly Record<string, unknown>[],
  read: () => ProfileStateDomainsReadResult
): void {
  MaterialHistoryAssertionSchema.parse(expected)
  const rows = sizes()
  let total = 0
  for (const row of rows) {
    if (typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new Error('E_MATERIAL_HISTORY_UNVERIFIABLE')
    }
    total += row.bytes
  }
  if (rows.length !== 3 || total > 8 * 1024 * 1024) {
    throw new Error('E_MATERIAL_HISTORY_LIMIT')
  }
  const observed = read()
  if (observed.kind !== 'values' || observed.revision !== revision) {
    throw new Error('E_MATERIAL_HISTORY_REVISION_CONFLICT')
  }
  assertMaterialHistoryDomains(observed.values, expected)
}

export function assertMaterialHistoryOnConnection(
  db: Database.Database | undefined,
  revision: number,
  expected: MaterialHistoryAssertion,
  read: (db: Database.Database, domains: readonly string[]) => ProfileStateDomainsReadResult
): void {
  if (!db) {
    throw new Error('E_MATERIAL_HISTORY_AUTHORITY_UNAVAILABLE')
  }
  const domains = ['worktreeMeta', 'worktreeMetaByIdentity', 'worktreeIdentityAliases']
  withProfileStateReadSnapshot(db, () =>
    assertMaterialHistoryReadback(
      expected,
      revision,
      () =>
        db
          .prepare(
            'SELECT length(CAST(payload AS BLOB)) AS bytes FROM profile_state_documents WHERE domain IN (?, ?, ?)'
          )
          .all(...domains),
      () => read(db, domains)
    )
  )
}

export function validRetainedHistory(meta: WorktreeMeta): boolean {
  const h = meta.materialHistory
  return (
    !!h &&
    MaterialHistoryAssertionSchema.safeParse({
      schemaVersion: h.schemaVersion,
      executionHostId: meta.hostId,
      worktreeId: h.worktreeId,
      historicalInstanceId: h.historicalInstanceId,
      requestId: h.requestId,
      metadataDigest: h.metadataDigest,
      historyDigest: hashCanonical(h)
    }).success &&
    !!splitWorktreeId(h.worktreeId!) &&
    isRecord(h.snapshot) &&
    !h.snapshot.materialHistory &&
    h.snapshot.hostId === 'local' &&
    h.snapshot.instanceId === h.historicalInstanceId &&
    Buffer.byteLength(JSON.stringify(h.snapshot)) <= 65_536 &&
    hashCanonical(h.snapshot) === h.metadataDigest &&
    !!h.representations &&
    typeof h.representations.legacy === 'boolean' &&
    Array.isArray(h.representations.canonicalKeys) &&
    h.representations.canonicalKeys.every((key) => typeof key === 'string') &&
    isRecord(h.representations.aliases) &&
    Object.values(h.representations.aliases).every(
      (keys) =>
        Array.isArray(keys) && keys.length <= 64 && keys.every((key) => typeof key === 'string')
    )
  )
}
