import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { lstat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import type { OrchestrationDb } from './orchestration/db'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import type { MaterialMetadataCensus } from '../persistence/tracking-repos/local-worktree-material-census'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseExecutionHostId } from '../../shared/execution-host'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'

export type MaterialAdmissionInput = {
  selector?: string
  cwd?: string
  executionHostId?: string | null
  connectionId?: string | null
  repoId?: string
  branch?: string
  creatingWorktree?: boolean
}
export type MaterialAdmissionAuthority = {
  getExistingDb(): OrchestrationDb | null
  captureCensus(targetId: string): MaterialMetadataCensus | null
}
export type MaterialAdmissionHold = {
  revalidate(input?: MaterialAdmissionInput): void
  release(): void
}
type MaterialMutationIdentity = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}
type Window = { readers: number; writer?: MaterialMutationIdentity }
const windows = new WeakMap<MaterialAdmissionAuthority, Window>()
const restored = new AsyncLocalStorage<{
  authority: MaterialAdmissionAuthority
  identity: MaterialMutationIdentity
  manifest: MaterialManifest
}>()
export const materialAdmissionContext = Symbol('material-admission-context')
export type MaterialAdmissionRequest = { [materialAdmissionContext]?: MaterialAdmissionAuthority }

function admissionWindow(authority: MaterialAdmissionAuthority): Window {
  let window = windows.get(authority)
  if (!window) {
    window = { readers: 0 }
    windows.set(authority, window)
  }
  return window
}
function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b)
  return (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}
export function materialLocalPath(location: string): string {
  let current = path.resolve(location)
  const suffix: string[] = []
  while (true) {
    try {
      return path.join(realpathSync.native(current), ...suffix)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
      }
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}
function assertAdmission(authority: MaterialAdmissionAuthority, input: MaterialAdmissionInput) {
  const host = parseExecutionHostId(input.executionHostId)
  if (input.connectionId || (host && host.kind !== 'local')) {
    return
  }
  if (input.executionHostId && !host) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  const db = authority.getExistingDb()
  const claims = db ? db.readPendingMaterialClaims() : []
  if (claims === null) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  if (!claims.length) {
    return
  }
  const selector = input.selector?.replace(/^id:/, '')
  const census = authority.captureCensus(selector ?? '')
  if (!census?.complete) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
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
  if (targets.size > 1) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  const resolved = [...targets.values()][0]
  if (resolved && resolved.hostId !== 'local') {
    if (host?.kind === 'local' || !parseExecutionHostId(resolved.hostId)) {
      throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
    }
    return
  }
  const workspace = splitWorktreeIdForFilesystem(
    resolved?.worktreeId ?? selector ?? ''
  )?.worktreePath
  if (selector && (!workspace || !path.isAbsolute(workspace))) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  if (input.cwd && !path.isAbsolute(input.cwd) && !workspace) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  const cwd = input.cwd ? path.resolve(workspace ?? '/', input.cwd) : undefined
  const locations = [workspace, cwd].filter((item): item is string => !!item).map(materialLocalPath)
  for (const claim of claims) {
    if (claim.executionHostId !== 'local') {
      continue
    }
    if (
      locations.some(
        (location) => overlaps(claim.path, location) || overlaps(location, claim.path)
      ) ||
      selector === claim.worktreeId ||
      (input.repoId === claim.repo.replace(/^id:/, '') && input.branch === claim.branch)
    ) {
      throw new Error('E_MATERIAL_TARGET_RESERVED')
    }
  }
  // The internal create entrypoints resolve their candidate by reading before revalidation.
  if (!locations.length && !(input.creatingWorktree || (input.repoId && input.branch))) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
}

/** No queued writer: a desktop shared call may reenter through a new IPC context. */
export async function acquireMaterialAdmission(
  authority: MaterialAdmissionAuthority | undefined,
  input: MaterialAdmissionInput
): Promise<MaterialAdmissionHold> {
  if (!authority) {
    throw new Error('E_MATERIAL_ADMISSION_AUTHORITY_UNAVAILABLE')
  }
  const window = admissionWindow(authority)
  let tracked = false
  const admit = (actual: MaterialAdmissionInput) => {
    const host = parseExecutionHostId(actual.executionHostId)
    const local = !actual.connectionId && (!host || host.kind === 'local')
    if (local && window.writer) {
      throw new Error('E_MATERIAL_ADMISSION_BUSY')
    }
    assertAdmission(authority, actual)
    if (local && !tracked) {
      window.readers++
      tracked = true
    }
  }
  admit(input)
  let released = false

  return {
    revalidate: (actual = input) => {
      if (released) {
        throw new Error('E_MATERIAL_ADMISSION_RELEASED')
      }
      admit(input)
      admit(actual)
    },
    release: () => {
      if (!released) {
        released = true
        window.readers -= Number(tracked)
      }
    }
  }
}

export async function withMaterialAdmission<T>(
  authority: MaterialAdmissionAuthority | undefined,
  input: MaterialAdmissionInput,
  operation: (hold: MaterialAdmissionHold) => Promise<T>
): Promise<T> {
  const hold = await acquireMaterialAdmission(authority, input)
  try {
    return await operation(hold)
  } finally {
    hold.release()
  }
}

/** Acquired synchronously before BEGIN; a busy ordinary operation leaves no new durable claim. */
export function acquireMaterialMutation(
  authority: MaterialAdmissionAuthority,
  identity: MaterialMutationIdentity,
  manifest: MaterialManifest
) {
  const window = admissionWindow(authority)
  if (window.writer || window.readers) {
    throw new Error('E_MATERIAL_ADMISSION_BUSY')
  }
  window.writer = identity
  let active = true
  return {
    run: <T>(operation: () => T): T => {
      if (!active || window.writer !== identity) {
        throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
      }
      return restored.run({ authority, identity, manifest }, operation)
    },
    release: () => {
      if (active) {
        active = false
        delete window.writer
      }
    }
  }
}

export async function withMaterialRestoreAdmission<T>(
  authority: MaterialAdmissionAuthority,
  manifest: MaterialManifest,
  requestId: string,
  operation: () => Promise<T>
): Promise<T> {
  const permit = restored.getStore()
  if (
    !permit ||
    permit.authority !== authority ||
    permit.identity.requestId !== requestId ||
    admissionWindow(authority).writer !== permit.identity ||
    hashCanonical(permit.manifest) !== hashCanonical(manifest)
  ) {
    throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
  }
  const row = authority
    .getExistingDb()
    ?.getMutationReceipt(permit.identity.callerFingerprint, requestId)
  if (
    !row ||
    row.state !== 'pending' ||
    row.method !== permit.identity.method ||
    row.payload_hash !== permit.identity.payloadHash ||
    !row.receipt ||
    Buffer.byteLength(row.receipt) > 32_768
  ) {
    throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
  }
  const recorded: unknown = JSON.parse(row.receipt)
  if (
    !recorded ||
    typeof recorded !== 'object' ||
    !('materialTarget' in recorded) ||
    Object.keys(recorded).length !== 1 ||
    hashCanonical(recorded.materialTarget) !== hashCanonical(manifest)
  ) {
    throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
  }
  return operation()
}

export async function materialPathAbsent(filename: string): Promise<boolean> {
  try {
    await lstat(filename)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}
export async function absentLocalMaterialPath(target: string): Promise<boolean> {
  if (
    !path.isAbsolute(target) ||
    path.normalize(target) !== target ||
    !(await materialPathAbsent(target))
  ) {
    return false
  }
  let cursor = path.dirname(target)
  while (true) {
    if (!(await materialPathAbsent(cursor))) {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false
      }
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      return true
    }
    cursor = parent
  }
}
