import path from 'node:path'
import type { WorktreeMeta } from './meta-types'
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
    /** Managed PTYs and structured records only; never all UID processes or custody. */
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
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (Reflect.get(value, key) !== undefined) {
      result[key] = canonicalMaterialValue(Reflect.get(value, key))
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

/** SHA-1 index v2/v3: extensions begin after padded entries, never inside pathname bytes. */
export function materialIndexIsWhole(index: Buffer): boolean {
  try {
    const end = index.length - 20
    requireIndex(end >= 12 && index.subarray(0, 4).toString() === 'DIRC')
    const version = index.readUInt32BE(4)
    const count = index.readUInt32BE(8)
    requireIndex([2, 3].includes(version) && count <= 20_000)
    requireIndex(
      createHash('sha1').update(index.subarray(0, end)).digest().equals(index.subarray(end))
    )
    let cursor = 12
    for (let i = 0; i < count; i++) {
      const start = cursor
      requireIndex(start + 62 <= end)
      const flags = index.readUInt16BE(start + 60)
      const extended = (flags & 0x4000) !== 0
      requireIndex(!extended || version === 3)
      const nameStart = start + 62 + (extended ? 2 : 0)
      requireIndex(nameStart < end)
      const nameEnd = index.indexOf(0, nameStart)
      const length = nameEnd - nameStart
      requireIndex(nameEnd < end && length >= 0 && length <= 4096)
      requireIndex((flags & 0xfff) === Math.min(length, 0xfff))
      cursor = start + Math.ceil((nameEnd - start + 1) / 8) * 8
      requireIndex(cursor <= end && index.subarray(nameEnd, cursor).every((byte) => byte === 0))
    }
    while (cursor < end) {
      requireIndex(cursor + 8 <= end)
      const signature = index.subarray(cursor, cursor + 4).toString('ascii')
      const size = index.readUInt32BE(cursor + 4)
      requireIndex(signature !== 'link' && size <= end - cursor - 8)
      cursor += 8 + size
    }
    requireIndex(cursor === end)
    return true
  } catch {
    return false
  }
}
function requireIndex(condition: unknown): asserts condition {
  if (!condition) {
    throw new Error('E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED')
  }
}

export type MaterialAdmissionInput = {
  selector?: string
  cwd?: string
  executionHostId?: string | null
  connectionId?: string | null
  repoId?: string
  branch?: string
  creatingWorktree?: boolean
}

export type MaterialMutationIdentity = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}
export type MaterialAdmissionScope = {
  locations: string[]
  selector?: string
  repoId?: string
  branch?: string
  remote: boolean
}

export type MaterialMetadataRow = {
  key: string
  worktreeId: string | null
  hostId: string | null
  instanceId: string | null
  metadata: WorktreeMeta
  retained?: boolean
}
export type MaterialMetadataCensus = {
  complete: boolean
  reason: 'complete' | 'limit' | 'opaque' | 'collision'
  rows: MaterialMetadataRow[]
  metadata: WorktreeMeta | null
  metadataDigest: string | null
  ownershipDigest: string | null
}

/** An incomplete census or ambiguous alias is never an admission target. */
export function resolveMaterialCensusSelector(
  census: MaterialMetadataCensus | null,
  selector: string
): MaterialMetadataRow | null {
  if (!census?.complete) {
    return null
  }
  const candidates = census.rows.filter(
    (row) =>
      !row.retained &&
      (row.worktreeId === selector ||
        row.key === selector ||
        row.metadata.displayName === selector ||
        `issue:${row.metadata.linkedIssue}` === selector)
  )
  const targets = new Map(candidates.map((row) => [`${row.hostId}|${row.worktreeId}`, row]))
  return targets.size === 1 ? [...targets.values()][0] : null
}

/** Effective configuration is a separate safety gate, never a HOME-dependent receipt binding. */
export function materialGitConfigIsPlain(config: string): boolean {
  const unsafe = /^(core\.fsmonitor|filter\..*\.(clean|smudge|process))(=.+|$)/
  const partial = /^(extensions\.partialclone|remote\..*\.promisor)(=|$)/
  return !config.split('\n').some((line) => unsafe.test(line) || partial.test(line))
}

export function materialPathsOverlap(a: string, b: string): boolean {
  const relative = path.relative(a, b)
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

export function requireMaterialProof(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new Error(code)
  }
}

/** Plain stage-zero entries only; the caller still compares their exact sequence with the tree. */
export function materialIndexEntries(staged: string): string[] | null {
  const entries: string[] = []
  for (const line of staged.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)$/.exec(line)
    if (
      !match ||
      Buffer.byteLength(match[3]) > 4096 ||
      match[3].split('/').some((part) => !part || part === '..' || part.toLowerCase() === '.git')
    ) {
      return null
    }
    entries.push(`${match[1]} blob ${match[2]}\t${match[3]}`)
  }
  return entries
}
