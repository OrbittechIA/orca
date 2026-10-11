import type {
  MaterialManifest,
  MaterialHistoryAssertion
} from '../../../shared/worktree/material-types'
import {
  captureLocalWorktreeMaterialCensus,
  stageMaterialHistoryState,
  publishMaterialIdentityState
} from '../tracking-repos/local-worktree-material-census'
import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Repo } from '../../../shared/repo-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { scheduleSave } from './write-scheduling'
import {
  hasPersistedWorkspaceSession,
  partitionOwnsWorktreeTabs,
  partitionHasOtherRepoWorktreeTabs,
  removeWorkspaceSessionOwnerInPartition
} from './session-host-partitions'
import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../tracking-repos/worktree-identity-migration'
import {
  getAllWorktreeMetaForHost as getAllWorktreeMetaForHostOperation,
  getWorktreeMetaForHost as getWorktreeMetaForHostOperation,
  migrateWorktreeMetadataLocator,
  removeWorktreeMetadataForHost,
  setWorktreeMetaForHost as setWorktreeMetaForHostOperation,
  WORKTREE_METADATA_DOMAINS
} from './worktree-identity-metadata'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import {
  captureNativeLocalWorktreeMetadataScanExpectation as captureNativeLocalWorktreeMetadataScanExpectationOperation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo as pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation,
  selectProbeableLocalWorktreeMetadataCandidates as selectProbeableLocalWorktreeMetadataCandidatesOperation,
  type LocalWorktreeMetadataPruneExpectation,
  type NativeLocalWorktreeMetadataScanExpectation
} from '../tracking-repos/missing-local-worktree-metadata-pruning'

type MetadataLineageOperationsRuntime = Pick<StoreRuntimeState, 'state'>

const lineageContext = Symbol('MetadataLineageOperations')
type MetadataLineageOperationsContext = {
  runtime: MetadataLineageOperationsRuntime
  scheduling: WriteSchedulingOperations
  sessions: SessionHostPartitionOperations
}

export class MetadataLineageOperations {
  readonly [lineageContext]: MetadataLineageOperationsContext

  constructor(
    runtime: MetadataLineageOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    sessions: SessionHostPartitionOperations
  ) {
    this[lineageContext] = { runtime, scheduling, sessions }
  }
  captureLocalWorktreeMaterialCensus(worktreeId: string) {
    return captureLocalWorktreeMaterialCensus(this[lineageContext].runtime.state, worktreeId)
  }
  stageMaterialHistory(manifest: MaterialManifest, requestId: string) {
    const { runtime, scheduling } = this[lineageContext]
    const result = stageMaterialHistoryState(runtime.state, manifest, requestId)
    scheduleSave(scheduling, WORKTREE_METADATA_DOMAINS)
    return result
  }
  publishMaterialIdentity(expected: MaterialHistoryAssertion) {
    const result = publishMaterialIdentityState(this[lineageContext].runtime.state, expected)
    scheduleSave(this[lineageContext].scheduling, WORKTREE_METADATA_DOMAINS)
    return result
  }
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined {
    return this[lineageContext].runtime.state.worktreeMeta[worktreeId]
  }

  getWorktreeMetaForHost(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): WorktreeMeta | undefined {
    return getWorktreeMetaForHostOperation(
      this[lineageContext].runtime,
      this[lineageContext].scheduling,
      worktreeId,
      executionHostId
    )
  }

  setWorktreeMetaForHost(
    worktreeId: string,
    executionHostId: ExecutionHostId,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ): WorktreeMeta {
    return setWorktreeMetaForHostOperation(
      this[lineageContext].runtime,
      this[lineageContext].scheduling,
      worktreeId,
      executionHostId,
      meta
    )
  }

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this[lineageContext].runtime.state.worktreeMeta
  }

  getAllWorktreeMetaForHost(executionHostId: ExecutionHostId): Record<string, WorktreeMeta> {
    return getAllWorktreeMetaForHostOperation(this[lineageContext].runtime, executionHostId)
  }

  captureNativeLocalWorktreeMetadataScanExpectation(
    repo: Repo
  ): NativeLocalWorktreeMetadataScanExpectation {
    return captureNativeLocalWorktreeMetadataScanExpectationOperation(
      this[lineageContext].runtime.state,
      repo
    )
  }

  setWorktreeMeta(
    worktreeId: string,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ): WorktreeMeta {
    const state = this[lineageContext].runtime.state
    const stored = state.worktreeMeta[worktreeId]
    const executionHostId = meta.hostId ?? stored?.hostId
    if (executionHostId) {
      return setWorktreeMetaForHostOperation(
        this[lineageContext].runtime,
        this[lineageContext].scheduling,
        worktreeId,
        executionHostId,
        meta
      )
    }
    const updated = mergeWorktreeMetaForWrite(stored, meta)
    state.worktreeMeta[worktreeId] = updated
    scheduleSave(this[lineageContext].scheduling, ['worktreeMeta'])
    return updated
  }

  removeWorktreeMeta(worktreeId: string, hostId?: ExecutionHostId | null): void {
    const { runtime, sessions, scheduling } = this[lineageContext]
    // A host-qualified removal names the owner; the persisted host is the fallback.
    const persistedOwner = runtime.state.worktreeMeta[worktreeId]?.hostId
    const owner = hostId ?? persistedOwner
    const preservesDifferentPersistedOwner = Boolean(
      hostId && persistedOwner && persistedOwner !== hostId
    )
    const ownerPartition = workspaceSessionOwnerPartitionForHost(owner)
    const preservesSameIdSessionOwner = Boolean(
      preservesDifferentPersistedOwner ||
      (owner &&
        hasWorktreeRemovalRepoOwnerOnOtherHost(
          { getRepos: () => runtime.state.repos },
          getRepoIdFromWorktreeId(worktreeId),
          ownerPartition
        ))
    )
    // Mirror the legacy delete's scope below: a full removal takes every host's identity rows,
    // otherwise the surviving owner keeps its own.
    removeWorktreeMetadataForHost(
      runtime.state,
      worktreeId,
      hostId === undefined ? undefined : (hostId ?? undefined)
    )
    // Skip partitions main never wrote: materializing one fences every sibling worktree of the repo.
    const partitions = new Set<ExecutionHostId>(
      workspaceSessionPartitionIdsForHost(owner).filter(
        (partition) =>
          hasPersistedWorkspaceSession(sessions, partition) &&
          // The local partition can be a remote spill surface or a same-id owner.
          // Preserve it whenever another owner may still use the bare id.
          (!preservesSameIdSessionOwner || partition === ownerPartition)
      )
    )
    // A repo-wide fence must not rebase a sibling's unpersisted tabs onto main's copy, and a spill
    // partition that never held this worktree has no claim on the repo at all.
    const fencedPartitions = new Set(
      [...partitions].filter(
        (partition) =>
          partitionOwnsWorktreeTabs(sessions, worktreeId, partition) ||
          (partition === ownerPartition &&
            !partitionHasOtherRepoWorktreeTabs(sessions, worktreeId, partition))
      )
    )
    if (!preservesDifferentPersistedOwner) {
      delete runtime.state.worktreeMeta[worktreeId]
      delete runtime.state.worktreeLineageById[worktreeId]
      delete runtime.state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
    }
    for (const partition of partitions) {
      removeWorkspaceSessionOwnerInPartition(sessions, worktreeId, partition, {
        advanceTerminalTopologyRevision: fencedPartitions.has(partition)
      })
    }
    // Why: dropping a row can free the identity key that was vetoing an unrelated row's removal, so
    // the metadata prune needs to look again — it is otherwise waiting on evidence (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
    scheduleSave(scheduling)
  }

  selectProbeableLocalWorktreeMetadataCandidates(
    scan: NativeLocalWorktreeMetadataScanExpectation
  ): readonly LocalWorktreeMetadataPruneExpectation[] {
    return selectProbeableLocalWorktreeMetadataCandidatesOperation(
      this[lineageContext].runtime.state,
      scan
    )
  }

  pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    scan: NativeLocalWorktreeMetadataScanExpectation,
    missingMetadata: readonly LocalWorktreeMetadataPruneExpectation[]
  ): string[] {
    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation(
      this[lineageContext].runtime.state,
      scan,
      missingMetadata.filter(
        (row) => !this[lineageContext].runtime.state.worktreeMeta[row.worktreeId]?.materialHistory
      )
    )
    if (removed.length > 0) {
      scheduleSave(this[lineageContext].scheduling)
    }
    return removed
  }

  getWorktreeLineage(worktreeId: string): WorktreeLineage | undefined {
    return this[lineageContext].runtime.state.worktreeLineageById[worktreeId]
  }

  getAllWorktreeLineage(): Record<string, WorktreeLineage> {
    return this[lineageContext].runtime.state.worktreeLineageById
  }

  setWorktreeLineage(worktreeId: string, lineage: WorktreeLineage): WorktreeLineage {
    this[lineageContext].runtime.state.worktreeLineageById[worktreeId] = lineage
    scheduleSave(this[lineageContext].scheduling)
    return lineage
  }

  removeWorktreeLineage(worktreeId: string): void {
    delete this[lineageContext].runtime.state.worktreeLineageById[worktreeId]
    scheduleSave(this[lineageContext].scheduling)
  }

  migrateWorktreeIdentity(
    oldWorktreeId: string,
    newWorktreeId: string,
    executionHostId?: ExecutionHostId
  ): void {
    const state = this[lineageContext].runtime.state
    const persistedOwner = state.worktreeMeta[oldWorktreeId]?.hostId
    const mover = executionHostId ?? persistedOwner ?? LOCAL_EXECUTION_HOST_ID
    const legacyChanged =
      executionHostId !== undefined &&
      persistedOwner !== undefined &&
      persistedOwner !== executionHostId
        ? false
        : migrateWorktreeIdentityOperation(state, oldWorktreeId, newWorktreeId)
    const canonicalChanged = migrateWorktreeMetadataLocator(
      state,
      oldWorktreeId,
      newWorktreeId,
      mover
    )
    if (legacyChanged || canonicalChanged) {
      // Legacy identity moves also re-key sessions, lineage, mobile selections, and UI state.
      scheduleSave(
        this[lineageContext].scheduling,
        legacyChanged ? undefined : WORKTREE_METADATA_DOMAINS
      )
    }
  }

  getWorkspaceLineage(childWorkspaceKey: WorkspaceKey): WorkspaceLineage | undefined {
    return this[lineageContext].runtime.state.workspaceLineageByChildKey[childWorkspaceKey]
  }

  getAllWorkspaceLineage(): Record<WorkspaceKey, WorkspaceLineage> {
    return this[lineageContext].runtime.state.workspaceLineageByChildKey
  }

  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    this[lineageContext].runtime.state.workspaceLineageByChildKey[lineage.childWorkspaceKey] =
      lineage
    scheduleSave(this[lineageContext].scheduling)
    return lineage
  }

  removeWorkspaceLineage(childWorkspaceKey: WorkspaceKey): void {
    delete this[lineageContext].runtime.state.workspaceLineageByChildKey[childWorkspaceKey]
    scheduleSave(this[lineageContext].scheduling)
  }
}

export function removeWorkspaceLineageForFolderParent(
  owner: MetadataLineageOperations,
  folderWorkspaceId: string
): void {
  const parentKey = folderWorkspaceKey(folderWorkspaceId)
  for (const [childKey, lineage] of Object.entries(
    owner[lineageContext].runtime.state.workspaceLineageByChildKey
  )) {
    if (lineage.parentWorkspaceKey === parentKey) {
      delete owner[lineageContext].runtime.state.workspaceLineageByChildKey[
        childKey as WorkspaceKey
      ]
    }
  }
}

export function installMetadataLineageOperationsContext(
  target: MetadataLineageOperations,
  source: MetadataLineageOperations
): void {
  Object.defineProperty(target, lineageContext, {
    value: source[lineageContext]
  })
}
