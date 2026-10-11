import type { Repo } from '../../shared/repo-types'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../persistence/tracking-repos/local-worktree-metadata-scan-expectation'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type {
  MaterialManifest,
  MaterialPlan,
  MaterialCode
} from '../../shared/worktree/material-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'
import { inspectMaterialGit } from './runtime-worktree-material-git'

export type MaterialAuthority = {
  repos: Repo[]
  snapshot: NativeLocalWorktreeMetadataScanExpectation | null
}

export async function planWorktreeMaterial(
  authority: MaterialAuthority,
  manifest: MaterialManifest
): Promise<MaterialPlan> {
  let code: MaterialCode = 'E_MATERIAL_METADATA_UNVERIFIABLE'
  let metadataDigest: string | null = null
  let catalogDigest: string | null = null
  let gitComplete = false
  let candidateRoute: 'checkout-index' | undefined
  const repo = authority.repos.find(
    (row) => `id:${row.id}` === manifest.repo && getRepoExecutionHostId(row) === 'local'
  )
  const local =
    manifest.executionHostId === 'local' && repo && repo.kind !== 'folder' && !repo.connectionId
  const row = authority.snapshot?.metadata.find((item) => item.worktreeId === manifest.worktreeId)
  const candidates = row
    ? [row.expectedLegacy, ...row.expectedAliases.flatMap((alias) => alias.expectedIdentityRows)]
    : []
  const present = candidates.filter((candidate) => candidate.expectedPresent)
  const unambiguous =
    present.length > 0 &&
    present.every(
      (candidate) =>
        candidate.expectedSerialized &&
        candidate.expectedSerialized === present[0].expectedSerialized
    ) &&
    (!row?.expectedAliases.length ||
      row.expectedAliases.every(
        (alias) =>
          alias.alias === `local|${manifest.worktreeId}` &&
          alias.expectedIdentityKeys.length === 1 &&
          alias.expectedIdentityRows.every((item) => item.expectedPresent)
      ))
  const metadata: WorktreeMeta | undefined = unambiguous ? present[0].expectedMeta : undefined
  if (!local) code = 'E_MATERIAL_HOST_UNSUPPORTED'
  else if (manifest.worktreeId !== `${repo.id}::${manifest.path}`) code = 'E_MATERIAL_PATH_CONFLICT'
  else if (metadata) {
    metadataDigest = hashCanonical(metadata)
    if (
      (metadata.instanceId ?? null) !== manifest.historicalInstanceId ||
      metadata.hostId !== 'local' ||
      metadata.linkedIssue !== manifest.linkedIssue ||
      metadata.linkedPR !== manifest.linkedReview ||
      metadataDigest !== manifest.expectedMetadataDigest
    )
      code = 'E_MATERIAL_METADATA_CONFLICT'
    else {
      const observed = await inspectMaterialGit(repo.path, manifest)
      gitComplete = observed.complete
      candidateRoute = observed.route
      catalogDigest = observed.digest
        ? hashCanonical({ git: observed.digest, metadata: authority.snapshot?.metadata })
        : null
      code =
        manifest.expectedCatalogDigest && catalogDigest !== manifest.expectedCatalogDigest
          ? 'E_MATERIAL_CAS_CONFLICT'
          : observed.code
    }
  }
  const { expectedPlanDigest, expectedCatalogDigest: _expectedCatalogDigest, ...tuple } = manifest
  const planDigest = hashCanonical({ tuple, metadataDigest, catalogDigest, code, gitComplete })
  if (expectedPlanDigest && expectedPlanDigest !== planDigest) code = 'E_MATERIAL_CAS_CONFLICT'
  return {
    schemaVersion: 1,
    state: 'blocked',
    code,
    wouldWrite: false,
    materializable: false,
    worktreeId: manifest.worktreeId,
    executionHostId: manifest.executionHostId,
    historicalInstanceId: manifest.historicalInstanceId,
    ...(candidateRoute ? { candidateRoute } : {}),
    metadataDigest,
    catalogDigest,
    planDigest,
    coverage: {
      git: gitComplete,
      hostMetadata: authority.snapshot ? 'aliased-local' : 'unverifiable',
      processes: 'unverifiable'
    }
  }
}

/** Pure staging only; the public restore remains blocked until complete custody census exists. */
export function retainMaterialHistory(
  metadata: WorktreeMeta,
  expectedDigest: string,
  requestId: string
): WorktreeMeta {
  if (
    metadata.materialHistory ||
    hashCanonical(metadata) !== expectedDigest ||
    Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 65_536 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
  ) {
    throw new Error('E_MATERIAL_METADATA_CONFLICT')
  }
  return {
    ...metadata,
    materialHistory: {
      schemaVersion: 1,
      requestId,
      historicalInstanceId: metadata.instanceId ?? null,
      metadataDigest: expectedDigest,
      snapshot: structuredClone(metadata)
    }
  }
}
