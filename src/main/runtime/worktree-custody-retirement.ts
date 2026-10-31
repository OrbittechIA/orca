import { randomUUID } from 'node:crypto'
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
import {
  installNativeWorktreeCustodyCoverage,
  nativeWorktreeCustodyResultJournal
} from './worktree-custody-runtime'
import { NativeRetirementResults } from './worktree-custody-native-results'
import type { CustodyCoverage } from './worktree-custody-authority'
import {
  resolveCheckoutRetirementPolicy,
  type CheckoutRetirementPolicy
} from './worktree-custody-checkout-policy'

const preEffectRefusals = new WeakMap<
  object,
  {
    retire: CustodyCoverage['retire']
    resourceKey: string
    proof: string
  }
>()

export function nativeWorktreePreEffectRefusal(
  retire: CustodyCoverage['retire'],
  error: unknown,
  resource: WorktreeCustodyResource
): string | null {
  const proof =
    error !== null && typeof error === 'object' ? preEffectRefusals.get(error) : undefined
  if (!proof || proof.retire !== retire || proof.resourceKey !== custodyResourceKey(resource)) {
    return null
  }
  return proof.proof
}

export type NativeWorktreeCustodyProvider = {
  owner: string
  /** Every extra proof comes from an owning native producer, including preservation and external access. */
  observe: CustodyCoverage['observe']
  acquire: CustodyCoverage['acquire']
  reconcile: CustodyCoverage['reconcile']
  recoverFence: CustodyCoverage['recoverFence']
  recoverRelease?: CustodyCoverage['recoverRelease']
  retirementPolicy?: CheckoutRetirementPolicy
  settleClientFence?: CustodyCoverage['settleClientFence']
}

async function boundedCheckout(
  resource: WorktreeCustodyResource,
  check: () => void,
  policy: CheckoutRetirementPolicy,
  deadline: number
): Promise<string> {
  const startedAt = Date.now()
  let ancestor = resource.path
  const root = parse(ancestor).root
  for (;;) {
    if ((await lstat(ancestor)).isSymbolicLink()) {
      throw new Error('custody_checkout_symlink')
    }
    if (ancestor === root) {
      break
    }
    ancestor = dirname(ancestor)
  }
  const identity = await lstat(resource.path)
  const pending = [{ path: resource.path, depth: 0 }]
  let files = 0
  let entries = 0
  let bytes = 0
  for (let next = pending.pop(); next; next = pending.pop()) {
    check()
    if (
      ++entries > policy.maxEntries ||
      next.depth > policy.maxDepth ||
      Date.now() >= deadline ||
      Date.now() - startedAt > policy.maxDurationMs
    ) {
      throw new Error('custody_effect_budget')
    }
    const info = await lstat(next.path)
    if (
      info.dev !== identity.dev ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      throw new Error('custody_checkout_identity_unsafe')
    }
    if (info.isDirectory()) {
      // Bound enumeration before retaining an arbitrary directory listing.
      const directory = await opendir(next.path)
      for await (const entry of directory) {
        check()
        if (pending.length + entries >= policy.maxEntries || Date.now() >= deadline) {
          throw new Error('custody_effect_budget')
        }
        pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 })
      }
    } else {
      if (!Number.isSafeInteger(info.blocks) || info.blocks < 0) {
        throw new Error('custody_checkout_allocation_unproven')
      }
      bytes += info.blocks * 512
      if (
        !info.isFile() ||
        !Number.isSafeInteger(bytes) ||
        info.nlink !== 1 ||
        ++files > policy.maxFiles ||
        bytes > policy.maxAllocatedBytes
      ) {
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
      if (supplied.length !== 1) {
        return entry
      }
      const proof = supplied[0]
      // Producer coverage may fill gaps, but cannot erase a native positive hold or active claim.
      return proof && entry.active !== true && entry.held !== true ? proof : entry
    })
  }
}

/** Native observation with owning producer gaps filled; also serves the observer-only installation. */
export function observeWithNativeProducer(
  runtime: OrcaRuntimeService,
  producer: Pick<NativeWorktreeCustodyProvider, 'observe'>
): CustodyCoverage['observe'] {
  return async (resource) => {
    const native = await observeNativeWorktreeCustody(runtime, resource)
    const supplied = await producer.observe(resource)
    if (custodyResourceKey(supplied.resource) !== custodyResourceKey(resource)) {
      return { ...native, domains: [] }
    }
    return mergeNativeObservation(native, supplied)
  }
}

/** Fixed native effect: no teardown, hooks, branch deletion, metadata purge, or history deletion. */
export function installNativeWorktreeCustodyRetirement(
  runtime: OrcaRuntimeService,
  producer: NativeWorktreeCustodyProvider,
  results = new NativeRetirementResults(nativeWorktreeCustodyResultJournal(), producer.owner)
): () => void {
  const policy = resolveCheckoutRetirementPolicy(producer.retirementPolicy)
  const retire: CustodyCoverage['retire'] = async (resource, check, key) => {
    const prepared = await (async () => {
      try {
        const deadline = Date.now() + policy.maxDurationMs
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
        if (repo.kind === 'folder' || repo.path === resource.path) {
          throw new Error('custody_folder_unsupported')
        }
        const identity = await boundedCheckout(resource, check, policy, deadline)
        await assertWorktreeCleanForRemoval(resource.path, false)
        const current = await lstat(resource.path)
        if (`${current.dev}:${current.ino}:${current.ctimeMs}` !== identity) {
          throw new Error('custody_checkout_changed')
        }
        check()
        if (typeof key !== 'string') {
          throw new Error('custody_native_key_missing')
        }
        // Durable intent precedes Git; failing to record it is still a pre-effect refusal.
        results.recordIntent(resource, key)
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error('custody_effect_budget')
        }
        return { repo, worktree, remaining, key }
      } catch (cause) {
        const error = new Error('custody_pre_effect_refused', { cause })
        preEffectRefusals.set(error, {
          retire,
          resourceKey: custodyResourceKey(resource),
          proof: `native-preflight:${randomUUID()}`
        })
        throw error
      }
    })()
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), prepared.remaining)
    try {
      await removeWorktree(prepared.repo.path, resource.path, false, {
        deleteBranch: false,
        knownRemovedWorktree: prepared.worktree.git,
        checkoutDeleteSignal: stop.signal
      })
    } catch (cause) {
      throw new Error('custody_effect_outcome_unknown', { cause })
    } finally {
      clearTimeout(timer)
    }
    // Completion is the native Git result; a missing path alone never reconciles an unknown effect.
    try {
      results.recordRemoved(resource, prepared.key)
    } catch {
      console.warn('[worktree-custody] native removal result not recorded')
    }
  }
  return installNativeWorktreeCustodyCoverage(
    producer.owner,
    {
      acquire: producer.acquire,
      // Only this fixed effect's committed removal confirms; otherwise the producer decides.
      reconcile: async (outcome) => results.confirmed(outcome) ?? producer.reconcile(outcome),
      recoverFence: producer.recoverFence,
      recoverRelease: producer.recoverRelease,
      settleClientFence: producer.settleClientFence,
      observe: observeWithNativeProducer(runtime, producer),
      retire
    },
    runtime.getRuntimeId()
  )
}
