import type { z } from 'zod'
import { createHash } from 'node:crypto'
import type {
  WorktreeMaterialManifest,
  MaterialHistoryAssertionSchema
} from '../rpc-contract/worktree-material-params'

export type MaterialManifest = z.infer<typeof WorktreeMaterialManifest>
export type MaterialCode =
  | 'MATERIAL_READY'
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
  state: 'blocked' | 'ready'
  code: MaterialCode
  wouldWrite: false
  materializable: boolean
  worktreeId: string
  executionHostId: string
  historicalInstanceId: string | null
  metadataDigest: string | null
  catalogDigest: string | null
  candidateRoute?: 'checkout-index'
  planDigest: string
  coverage: {
    git: boolean
    hostMetadata: 'complete' | 'aliased-local' | 'unverifiable'
    processes: 'complete' | 'unverifiable'
  }
}

export type MaterialHistoryAssertion = z.infer<typeof MaterialHistoryAssertionSchema>

/** Keep the persistence/CLI boundary independent of runtime RPC imports. */
export function materialHistoryDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalMaterialValue(value)))
    .digest('hex')
}

function canonicalMaterialValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalMaterialValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) {
      result[key] = canonicalMaterialValue(source[key])
    }
  }
  return result
}

export type MaterialReceiptClaim = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
  material?: MaterialManifest
}

export type MaterialGitObservation = {
  code: MaterialCode
  digest: string | null
  complete: boolean
  route?: 'checkout-index'
  adminDigest?: string
  admin?: string
  indexDigest?: string
}
