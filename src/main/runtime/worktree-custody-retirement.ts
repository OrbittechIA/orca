import { lstat, opendir } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import {
  custodyResourceKey,
  type WorktreeCustodyObservation,
  type WorktreeCustodyResource
} from '../../shared/worktree/custody'
import { removeWorktree, assertWorktreeCleanForRemoval } from '../git/worktree'
import type { OrcaRuntimeService } from './orca-runtime'
import { observeNativeWorktreeCustody } from './worktree-custody-observation'
import { installNativeWorktreeCustodyCoverage } from './worktree-custody-runtime'
import type { CustodyCoverage } from './worktree-custody-authority'

export type NativeWorktreeCustodyProvider = {
  owner: string
  /** Every extra proof comes from an owning native producer, including preservation and external access. */
  observe: CustodyCoverage['observe']
  acquire: CustodyCoverage['acquire']
  reconcile: CustodyCoverage['reconcile']
  recoverFence: CustodyCoverage['recoverFence']
}

async function boundedCheckout(
  resource: WorktreeCustodyResource,
  check: () => void
): Promise<string> {
  const startedAt = Date.now()
  let ancestor = resource.path
  const root = parse(ancestor).root
  for (;;) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('custody_checkout_symlink')
    if (ancestor === root) break
    ancestor = dirname(ancestor)
  }
  const identity = await lstat(resource.path)
  const pending = [{ path: resource.path, depth: 0 }]
  let files = 0
  let entries = 0
  let bytes = 0
  for (let next = pending.pop(); next; next = pending.pop()) {
    check()
    if (++entries > 4096 || next.depth > 128 || Date.now() - startedAt > 10_000) {
      throw new Error('custody_effect_budget')
    }
    const info = await lstat(next.path)
    if (
      info.dev !== identity.dev ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('custody_checkout_identity_unsafe')
    if (info.isDirectory()) {
      // Bound enumeration before retaining an arbitrary directory listing.
      const directory = await opendir(next.path)
      for await (const entry of directory) {
        if (pending.length + entries >= 4096) throw new Error('custody_effect_budget')
        pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 })
      }
    } else {
      bytes += info.blocks * 512
      if (!info.isFile() || info.nlink !== 1 || ++files > 2048 || bytes > 1024 ** 3) {
        throw new Error('custody_checkout_material_unsafe_or_oversized')
      }
    }
  }
  return `${identity.dev}:${identity.ino}:${identity.ctimeMs}`
}

function mergeNativeObservation(
  native: WorktreeCustodyObservation,
  producer: WorktreeCustodyObservation
): WorktreeCustodyObservation {
  return {
    ...native,
    domains: native.domains.map((entry) => {
      const supplied = producer.domains.filter((item) => item.domain === entry.domain)
      if (supplied.length !== 1) return entry
      const proof = supplied[0]
      // Producer coverage may fill gaps, but cannot erase a native positive hold or active claim.
      return proof && entry.active !== true && entry.held !== true ? proof : entry
    })
  }
}

/** Fixed native effect: no teardown, hooks, branch deletion, metadata purge, or history deletion. */
export function installNativeWorktreeCustodyRetirement(
  runtime: OrcaRuntimeService,
  producer: NativeWorktreeCustodyProvider
): () => void {
  return installNativeWorktreeCustodyCoverage(
    producer.owner,
    {
      acquire: producer.acquire,
      reconcile: producer.reconcile,
      recoverFence: producer.recoverFence,
      observe: async (resource) => {
        const native = await observeNativeWorktreeCustody(runtime, resource)
        const supplied = await producer.observe(resource)
        if (custodyResourceKey(supplied.resource) !== custodyResourceKey(resource))
          return { ...native, domains: [] }
        return mergeNativeObservation(native, supplied)
      },
      retire: async (resource, check) => {
        const deadline = Date.now() + 10_000
        check()
        const worktree = await runtime.showManagedWorktree(`id:${resource.worktreeId}`)
        if (
          resource.hostId !== 'local' ||
          worktree.hostId !== 'local' ||
          worktree.id !== resource.worktreeId ||
          worktree.projectId !== resource.product ||
          worktree.path !== resource.path ||
          worktree.instanceId !== resource.instanceId ||
          worktree.isMainWorktree ||
          worktree.isBare ||
          worktree.childWorktreeIds.length > 0
        ) {
          throw new Error('custody_checkout_replaced_or_unsupported')
        }
        const repo = await runtime.showRepo(`id:${worktree.repoId}`)
        if (repo.kind === 'folder' || repo.path === resource.path)
          throw new Error('custody_folder_unsupported')
        const identity = await boundedCheckout(resource, check)
        await assertWorktreeCleanForRemoval(resource.path, false)
        const current = await lstat(resource.path)
        if (`${current.dev}:${current.ino}:${current.ctimeMs}` !== identity) {
          throw new Error('custody_checkout_changed')
        }
        check()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('custody_effect_budget')
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), remaining)
        try {
          await removeWorktree(repo.path, resource.path, false, {
            deleteBranch: false,
            knownRemovedWorktree: worktree.git,
            checkoutDeleteSignal: stop.signal
          })
        } finally {
          clearTimeout(timer)
        }
        // Completion is the native Git result; a missing path alone never reconciles an unknown effect.
      }
    },
    runtime.getRuntimeId()
  )
}
