import path from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { materialLocalPath } from './runtime-worktree-material-admission'
import type {
  MaterialManifest,
  MaterialPlan,
  MaterialCode
} from '../../shared/worktree/material-types'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { encodeAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import {
  isProvenAliveProbe,
  isProvenDeadProbe
} from '../../shared/agent-session-lease-adjudication'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-owner-probe'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'
import { inspectMaterialGit, type MaterialGitObservation } from './runtime-worktree-material-git'

export type { MaterialAuthority } from './runtime-store-contract'
import type { MaterialAuthority } from './runtime-store-contract'

function within(target: string, cwd: string): boolean {
  const relative = path.relative(target, cwd)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

export async function observeMaterialProcessAbsence(
  authority: MaterialAuthority,
  manifest: MaterialManifest
): Promise<(() => boolean) | null> {
  const store = authority.peekStructured?.()
  if (!store || store.readOnly || !authority.observePty || !authority.census?.complete) {
    return null
  }
  const capture = () => {
    const held = store.listHeldSessionIds()
    const records = structuredClone(store.listRecords())
    if (
      held.length > 20_000 ||
      records.length !== held.length ||
      new Set(held).size !== held.length ||
      new Set(records.map((record) => record.sessionId)).size !== held.length ||
      records.some(
        (record) =>
          !held.includes(record.sessionId) ||
          !isPersistedAgentSessionRecord(encodeAgentSessionRecord(record))
      )
    ) {
      throw new Error('census_incomplete')
    }
    const projection = records.map(encodeAgentSessionRecord)
    if (Buffer.byteLength(JSON.stringify(projection)) > 8 * 1024 * 1024) {
      throw new Error('census_limit')
    }
    return { records, digest: hashCanonical(projection) }
  }
  const before = capture()
  const known = new Map(
    authority.census.rows
      .filter((row) => row.hostId === 'local' && !row.retained)
      .flatMap((row) =>
        row.worktreeId
          ? [row.worktreeId, ...(row.key.startsWith('wt2:') ? [row.key] : [])].map(
              (id): [string, string] => [id, row.worktreeId!]
            )
          : []
      )
  )
  const location = (id: string) => {
    const locator = splitWorktreeIdForFilesystem(known.get(id) ?? '')?.worktreePath
    return locator && path.isAbsolute(locator) ? materialLocalPath(locator) : null
  }
  const targetPath = materialLocalPath(manifest.path)
  const belongs = (id: string) => {
    const locator = location(id)
    return !locator || within(targetPath, locator) || within(locator, targetPath)
  }
  const deadlineMs = Date.now() + 5000
  const pty = await authority.observePty({ deadlineMs })
  if (pty.state !== 'complete' || !pty.stillCurrent()) {
    return null
  }
  for (const process of pty.processes) {
    const owners = process.agentSessionOwners
    const locator = process.worktreeId ? location(process.worktreeId) : null
    if (
      process.wslDistro ||
      !path.isAbsolute(process.cwd) ||
      !owners ||
      !process.worktreeId ||
      !locator ||
      within(targetPath, materialLocalPath(process.cwd)) ||
      belongs(process.worktreeId) ||
      owners.some(
        (owner) =>
          known.get(owner.surface.worktreeId) !== known.get(process.worktreeId!) ||
          belongs(owner.surface.worktreeId)
      )
    ) {
      return null
    }
  }
  const probe = createStructuredAgentSessionOwnerProbe(store.hostId)
  for (const record of before.records) {
    const host = parseExecutionHostId(record.location.executionHostId)
    if (!host || host.id !== record.location.executionHostId) {
      return null
    }
    if (host.kind !== 'local') {
      continue
    }
    if (
      record.location.wslDistro !== null ||
      (record.launchDirectory && !path.isAbsolute(record.launchDirectory)) ||
      !known.has(record.location.workspaceId) ||
      record.lease.unreconciled ||
      record.lease.handoffStage ||
      record.lease.claimStatus === 'reserved' ||
      record.lease.claimStatus === 'conflicted'
    ) {
      return null
    }
    const proof = await probe(record)
    const dead = isProvenDeadProbe(proof) || proof.outcome === 'reservation-unused'
    if ((!dead && !isProvenAliveProbe(proof)) || Date.now() >= deadlineMs) {
      return null
    }
    const target =
      belongs(record.location.workspaceId) ||
      (record.launchDirectory && within(targetPath, materialLocalPath(record.launchDirectory)))
    if (target && !dead) {
      return null
    }
  }
  const stillCurrent = () => {
    try {
      return (
        Date.now() < deadlineMs &&
        authority.peekStructured?.() === store &&
        !store.readOnly &&
        pty.stillCurrent() &&
        capture().digest === before.digest
      )
    } catch {
      return false
    }
  }
  return stillCurrent() ? stillCurrent : null
}

/** Freeze observed ownership, target metadata and repo routing across every asynchronous boundary. */
export function materialAuthorityFence(expected: MaterialAuthority, manifest: MaterialManifest) {
  const binding = (authority: MaterialAuthority) =>
    hashCanonical(
      authority.repos
        .filter((repo) => `id:${repo.id}` === manifest.repo)
        .map(({ id, path, executionHostId, connectionId, kind }) => [
          id,
          path,
          executionHostId,
          connectionId,
          kind
        ])
    )
  const repoDigest = binding(expected)
  const metadataDigest = expected.census?.metadataDigest
  const ownershipDigest = expected.census?.ownershipDigest
  return (fresh: MaterialAuthority) => {
    if (
      !fresh.census?.complete ||
      fresh.census.metadataDigest !== metadataDigest ||
      fresh.census.ownershipDigest !== ownershipDigest ||
      binding(fresh) !== repoDigest
    ) {
      throw new Error('E_MATERIAL_CAS_CONFLICT')
    }
    return fresh
  }
}

export async function inspectWorktreeMaterial(
  authority: MaterialAuthority,
  manifest: MaterialManifest
) {
  let code: MaterialCode = 'E_MATERIAL_METADATA_UNVERIFIABLE'
  let metadataDigest: string | null = null
  let catalogDigest: string | null = null
  let git: MaterialGitObservation | undefined
  let stillCurrent: (() => boolean) | null = null
  const repos = authority.repos.filter(
    (row) => `id:${row.id}` === manifest.repo && getRepoExecutionHostId(row) === 'local'
  )
  const repo = repos.length === 1 ? repos[0] : undefined
  const local =
    manifest.executionHostId === 'local' && repo && repo.kind !== 'folder' && !repo.connectionId
  const row = authority.snapshot?.metadata.find((item) => item.worktreeId === manifest.worktreeId)
  const present = row
    ? [
        row.expectedLegacy,
        ...row.expectedAliases.flatMap((alias) => alias.expectedIdentityRows)
      ].filter((candidate) => candidate.expectedPresent)
    : []
  const legacyMetadata =
    present.length &&
    present.every(
      (candidate) =>
        candidate.expectedSerialized &&
        candidate.expectedSerialized === present[0].expectedSerialized
    )
      ? present[0].expectedMeta
      : undefined
  const metadata = authority.census ? authority.census.metadata : legacyMetadata
  if (!local) {
    code = 'E_MATERIAL_HOST_UNSUPPORTED'
  } else if (manifest.worktreeId !== `${repo.id}::${manifest.path}`) {
    code = 'E_MATERIAL_PATH_CONFLICT'
  } else if (authority.census && !authority.census.complete) {
    code = 'E_MATERIAL_METADATA_UNVERIFIABLE'
  } else if (metadata) {
    metadataDigest = hashCanonical(metadata)
    if (
      (metadata.instanceId ?? null) !== manifest.historicalInstanceId ||
      metadata.hostId !== 'local' ||
      metadata.linkedIssue !== manifest.linkedIssue ||
      metadata.linkedPR !== manifest.linkedReview ||
      metadataDigest !== manifest.expectedMetadataDigest
    ) {
      code = 'E_MATERIAL_METADATA_CONFLICT'
    } else {
      git = await inspectMaterialGit(repo.path, manifest)
      catalogDigest = git.digest
        ? hashCanonical({
            git: git.digest,
            metadata: authority.census?.ownershipDigest ?? metadataDigest
          })
        : null
      code = git.code
      if (git.route === 'checkout-index' && authority.census?.complete) {
        try {
          stillCurrent = await observeMaterialProcessAbsence(authority, manifest)
        } catch {
          stillCurrent = null
        }
        if (
          stillCurrent &&
          authority.historyReadback &&
          metadata.instanceId &&
          !metadata.materialHistory
        ) {
          code = 'MATERIAL_READY'
        }
      }
      if (manifest.expectedCatalogDigest && catalogDigest !== manifest.expectedCatalogDigest) {
        code = 'E_MATERIAL_CAS_CONFLICT'
      }
    }
  }
  const { expectedPlanDigest, expectedCatalogDigest: _catalog, ...tuple } = manifest
  const planDigest = hashCanonical({
    tuple,
    metadataDigest,
    catalogDigest,
    code,
    gitComplete: git?.complete ?? false
  })
  if (expectedPlanDigest && expectedPlanDigest !== planDigest) {
    code = 'E_MATERIAL_CAS_CONFLICT'
  }
  const ready = code === 'MATERIAL_READY'
  const plan: MaterialPlan = {
    schemaVersion: 1,
    state: ready ? 'ready' : 'blocked',
    code,
    wouldWrite: false,
    materializable: ready,
    worktreeId: manifest.worktreeId,
    executionHostId: manifest.executionHostId,
    historicalInstanceId: manifest.historicalInstanceId,
    ...(git?.route ? { candidateRoute: git.route } : {}),
    metadataDigest,
    catalogDigest,
    planDigest,
    coverage: {
      git: git?.complete ?? false,
      hostMetadata: authority.census?.complete
        ? 'complete'
        : authority.snapshot
          ? 'aliased-local'
          : 'unverifiable',
      processes: stillCurrent ? 'complete' : 'unverifiable'
    }
  }
  return { plan, repo, git, stillCurrent }
}

export async function planWorktreeMaterial(
  authority: MaterialAuthority,
  manifest: MaterialManifest
): Promise<MaterialPlan> {
  return (await inspectWorktreeMaterial(authority, manifest)).plan
}
