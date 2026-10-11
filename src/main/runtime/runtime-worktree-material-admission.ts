import {
  materialPathsOverlap as overlaps,
  requireMaterialProof as requireAdmission,
  resolveMaterialCensusSelector,
  type MaterialAdmissionInput,
  type MaterialMutationIdentity,
  type MaterialAdmissionScope as Scope,
  type MaterialManifest,
  type MaterialMetadataCensus
} from '../../shared/worktree/material-types'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { lstat } from 'node:fs/promises'
import { realpathSync, lstatSync } from 'node:fs'
import type { OrchestrationDb } from './orchestration/db'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseExecutionHostId } from '../../shared/execution-host'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'

export type { MaterialAdmissionInput } from '../../shared/worktree/material-types'
export type MaterialAdmissionAuthority = {
  getExistingDb(): OrchestrationDb | null
  readPendingClaims(): MaterialManifest[] | null
  captureCensus(targetId: string): MaterialMetadataCensus | null
}
export type MaterialAdmissionHold = {
  readonly selector?: string
  revalidate(input?: MaterialAdmissionInput): void
  release(): void
}
type Window = { readers: Set<Scope>; writers: Map<MaterialMutationIdentity, MaterialManifest> }
const windows = new WeakMap<MaterialAdmissionAuthority, Window>()
const restored = new AsyncLocalStorage<{
  authority: MaterialAdmissionAuthority
  identity: MaterialMutationIdentity
  manifest: MaterialManifest
}>()
export const materialAdmissionContext = Symbol('material-admission-context')
export type MaterialAdmissionRequest = { [materialAdmissionContext]?: MaterialAdmissionAuthority }

function admissionWindow(authority: MaterialAdmissionAuthority): Window {
  const window: Window = windows.get(authority) ?? { readers: new Set(), writers: new Map() }
  windows.set(authority, window)
  return window
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
      requireAdmission(
        !lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink(),
        'E_MATERIAL_ADMISSION_UNVERIFIABLE'
      )
      const parent = path.dirname(current)
      requireAdmission(parent !== current, 'E_MATERIAL_ADMISSION_UNVERIFIABLE')
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}
function scopeFor(
  authority: MaterialAdmissionAuthority,
  input: MaterialAdmissionInput,
  requireProof = true
): Scope {
  const host = parseExecutionHostId(input.executionHostId)
  requireAdmission(!(input.executionHostId && !host), 'E_MATERIAL_ADMISSION_UNVERIFIABLE')
  if (input.connectionId || (host && host.kind !== 'local')) {
    return { remote: true, locations: [] }
  }
  let selector = input.selector?.replace(/^id:/, '')
  let parsed = splitWorktreeIdForFilesystem(selector ?? '')
  // Exact physical locators need no global ownership census to compare against reservations.
  // Aliases still require complete, unique resolution, including their execution host.
  if (selector && !parsed && !requireProof) {
    return { remote: false, locations: [] }
  }
  if (selector && !parsed) {
    const resolved = resolveMaterialCensusSelector(authority.captureCensus(selector), selector)
    requireAdmission(resolved, 'E_MATERIAL_ADMISSION_UNVERIFIABLE')
    if (resolved.hostId !== 'local') {
      if (host?.kind === 'local' || !parseExecutionHostId(resolved.hostId)) {
        throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
      }
      return { remote: true, locations: [] }
    }
    selector = resolved.worktreeId ?? undefined
    parsed = splitWorktreeIdForFilesystem(selector ?? '')
  }
  const workspace = parsed?.worktreePath
  if (
    (selector && (!workspace || !path.isAbsolute(workspace))) ||
    (input.cwd && !path.isAbsolute(input.cwd) && !workspace)
  ) {
    if (!requireProof) {
      return { remote: false, locations: [] }
    }
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
  const cwd = input.cwd ? path.resolve(workspace ?? '/', input.cwd) : undefined
  return {
    remote: false,
    selector,
    repoId: input.repoId ?? parsed?.repoId,
    branch: input.branch,
    locations: [workspace, cwd].filter((item): item is string => !!item)
  }
}
function conflicts(scope: Scope, claim: MaterialManifest): boolean {
  return (
    !scope.remote &&
    claim.executionHostId === 'local' &&
    (scope.locations
      .map(materialLocalPath)
      .some((location) => overlaps(claim.path, location) || overlaps(location, claim.path)) ||
      scope.selector === claim.worktreeId ||
      (scope.repoId === claim.repo.replace(/^id:/, '') && scope.branch === claim.branch))
  )
}
function checkClaims(authority: MaterialAdmissionAuthority, scope: Scope, resolving: boolean) {
  if (scope.remote) {
    return
  }
  const claims = authority.readPendingClaims()
  requireAdmission(!(claims === null), 'E_MATERIAL_ADMISSION_UNVERIFIABLE')
  requireAdmission(!claims.some((claim) => conflicts(scope, claim)), 'E_MATERIAL_TARGET_RESERVED')
  if (claims.length && !scope.locations.length && !resolving) {
    throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE')
  }
}

/** Unresolved creation is a read-only resolution barrier; revalidation precedes its first effect. */
export async function acquireMaterialAdmission(
  authority: MaterialAdmissionAuthority | undefined,
  input: MaterialAdmissionInput
): Promise<MaterialAdmissionHold> {
  requireAdmission(!!authority, 'E_MATERIAL_ADMISSION_AUTHORITY_UNAVAILABLE')
  const window = admissionWindow(authority)
  const held = new Set<Scope>()
  const admit = (actual: MaterialAdmissionInput, resolving = false) => {
    const host = parseExecutionHostId(actual.executionHostId)
    const remote = !!actual.connectionId || (!!host && host.kind !== 'local')
    const claims = remote ? [] : authority.readPendingClaims()
    requireAdmission(!(claims === null), 'E_MATERIAL_ADMISSION_UNVERIFIABLE')
    const scope = scopeFor(authority, actual, claims.length > 0 || window.writers.size > 0)
    if (
      !scope.remote &&
      [...window.writers.values()].some(
        (claim) => !scope.locations.length || conflicts(scope, claim)
      )
    ) {
      throw new Error('E_MATERIAL_ADMISSION_BUSY')
    }
    checkClaims(authority, scope, resolving)
    return scope
  }
  let current = admit(input, input.creatingWorktree === true)
  held.add(current)
  window.readers.add(current)
  let released = false
  return {
    get selector() {
      return current.selector ? `id:${current.selector}` : undefined
    },
    revalidate: (actual) => {
      requireAdmission(!released, 'E_MATERIAL_ADMISSION_RELEASED')
      if (actual) {
        const next = admit(actual)
        // Replace only the provisional barrier, retaining all already proven physical scopes.
        if (!current.locations.length) {
          window.readers.delete(current)
          held.delete(current)
        }
        current = next
        held.add(next)
        window.readers.add(next)
      }
      for (const scope of held) {
        if ([...window.writers.values()].some((claim) => conflicts(scope, claim))) {
          throw new Error('E_MATERIAL_ADMISSION_BUSY')
        }
        checkClaims(authority, scope, false)
      }
    },
    release: () => {
      if (!released) {
        released = true
        for (const scope of held) {
          window.readers.delete(scope)
        }
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
  if (
    [...window.writers.values()].some((claim) =>
      conflicts(
        scopeFor(authority, {
          selector: manifest.worktreeId,
          cwd: manifest.path,
          repoId: manifest.repo.replace(/^id:/, ''),
          branch: manifest.branch,
          executionHostId: manifest.executionHostId
        }),
        claim
      )
    ) ||
    [...window.readers].some(
      (scope) => !scope.remote && (!scope.locations.length || conflicts(scope, manifest))
    )
  ) {
    throw new Error('E_MATERIAL_ADMISSION_BUSY')
  }
  window.writers.set(identity, manifest)
  let active = true
  return {
    run: <T>(operation: () => T): T => {
      if (!active || !window.writers.has(identity)) {
        throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
      }
      return restored.run({ authority, identity, manifest }, operation)
    },
    release: () => {
      if (active) {
        active = false
        window.writers.delete(identity)
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
    !admissionWindow(authority).writers.has(permit.identity) ||
    hashCanonical(permit.manifest) !== hashCanonical(manifest)
  ) {
    throw new Error('E_MATERIAL_CLAIM_UNVERIFIABLE')
  }
  const db = authority.getExistingDb()
  requireAdmission(db, 'E_MATERIAL_CLAIM_UNVERIFIABLE')
  db.assertPendingMaterialClaim({ ...permit.identity, material: manifest })
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
