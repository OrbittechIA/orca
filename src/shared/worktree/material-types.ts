import type { z } from 'zod'
import type { WorktreeMaterialManifest } from '../rpc-contract/worktree-material-params'

export type MaterialManifest = z.infer<typeof WorktreeMaterialManifest>
export type MaterialCode =
  | 'E_MATERIAL_HOST_UNSUPPORTED'
  | 'E_MATERIAL_CENSUS_UNVERIFIABLE'
  | 'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
  | 'E_MATERIAL_METADATA_UNVERIFIABLE'
  | 'E_MATERIAL_METADATA_CONFLICT'
  | 'E_MATERIAL_SOURCE_CONFLICT'
  | 'E_MATERIAL_PATH_CONFLICT'
  | 'E_MATERIAL_REF_CONFLICT'
  | 'E_MATERIAL_ADMIN_CONFLICT'
  | 'E_MATERIAL_INVENTORY_UNVERIFIABLE'
  | 'E_MATERIAL_CAS_CONFLICT'
  | 'E_MATERIAL_HISTORICAL_ADMIN_UNVERIFIABLE'
export type MaterialPlan = {
  schemaVersion: 1
  state: 'blocked'
  code: MaterialCode
  wouldWrite: false
  materializable: false
  worktreeId: string
  executionHostId: string
  historicalInstanceId: string | null
  metadataDigest: string | null
  catalogDigest: string | null
  candidateRoute?: 'checkout-index'
  planDigest: string
  coverage: {
    git: boolean
    hostMetadata: 'aliased-local' | 'unverifiable'
    processes: 'unverifiable'
  }
}
