import path from 'node:path'
import { WorktreeMaterialRestore } from '../../../../shared/rpc-contract/worktree-material-params'
import type {
  MaterialManifest,
  MaterialReceiptClaim
} from '../../../../shared/worktree/material-types'
import { OrchestrationError } from '../orchestration-error'
import { ensureMutationReceiptCapacity } from '../mutation-receipt-capacity'
import type { MutationReceiptRow } from '../types'
import Database from '../../../sqlite/sync-database'
import { attachOrchestrationDbMethods } from './attach-orchestration-db-methods'
import { hardenOrchestrationDatabaseFiles } from './database-file-permissions'
import { backfillFederatedStubHomeRuns } from './federation/federated-stub-home-run-backfill'
import type { OrchestrationDbMethods } from './orchestration-db-methods'
import {
  createCoordinatorMailRoutingTrigger,
  createRunCoordinatorAddressTriggers,
  rememberCurrentRunCoordinatorHandles
} from './runs/run-coordinator-mail-routing'
import { createTables } from './schema/create-tables'
import { migrate } from './schema/migrate'
import { backfillStructuredWorkerOrcaSessionIds } from './schema/structured-worker-orca-session-backfill'
import { reconcileSettledWorkerDispatches } from './worker-dispatch/worker-dispatch-settlement'

class OrchestrationDbCore {
  db: Database.Database

  // Why: the orchestration DB is created lazily for ALL users, but only the
  // small minority who dispatch work ever have dispatch_contexts rows. The
  // renderer graph publish rebuilds orchestration context on every 16ms tick
  // (buildAgentOrchestrationByPaneKey), issuing 2 queries per terminal. Cache
  // emptiness so the non-orchestration majority short-circuits the whole
  // per-terminal fan-out. Only createDispatchContext flips this false→true.
  hasAnyDispatchContextsCache: boolean | undefined
  localMutationCallerFingerprint: string | undefined

  constructor(dbPath: (string & {}) | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    createTables.call(this as unknown as OrchestrationDb)
    migrate.call(this as unknown as OrchestrationDb)
    createRunCoordinatorAddressTriggers(this.db)
    backfillFederatedStubHomeRuns(this.db)
    backfillStructuredWorkerOrcaSessionIds(this.db)
    reconcileSettledWorkerDispatches(this.db)
    createCoordinatorMailRoutingTrigger.call(this as unknown as OrchestrationDb)
    rememberCurrentRunCoordinatorHandles.call(this as unknown as OrchestrationDb)
    hardenOrchestrationDatabaseFiles(dbPath)
  }

  beginMaterialMutationReceipt(
    this: OrchestrationDb,
    params: MaterialReceiptClaim
  ): ReturnType<OrchestrationDbMethods['beginMutationReceipt']> {
    const material =
      params.method === 'worktree.materialRestore'
        ? WorktreeMaterialRestore.parse({ requestId: params.requestId, manifest: params.material })
            .manifest
        : undefined
    const priorSync = material ? this.db.pragma('synchronous', { simple: true }) : undefined
    if (material) {
      this.db.pragma('synchronous = FULL')
    }
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const existing = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      if (existing) {
        if (existing.method !== params.method || existing.payload_hash !== params.payloadHash) {
          throw new OrchestrationError(
            'request_mismatch',
            `Mutation request ${params.requestId} was already used with different input.`
          )
        }
        this.db.exec('COMMIT')
        return { disposition: existing.state, row: existing }
      }
      if (material) {
        const claims = this.readPendingMaterialClaims()
        const contains = (a: string, b: string) => {
          const relative = path.relative(a, b)
          return (
            !relative ||
            (relative !== '..' &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          )
        }
        if (
          !claims ||
          claims.some(
            (claim) =>
              material.executionHostId === claim.executionHostId &&
              (contains(material.path, claim.path) ||
                contains(claim.path, material.path) ||
                (material.repo === claim.repo && material.branch === claim.branch))
          )
        ) {
          throw new OrchestrationError('operation_unknown', 'E_MATERIAL_TARGET_RESERVED')
        }
      }
      ensureMutationReceiptCapacity(this.db)
      this.db
        .prepare(
          `INSERT INTO mutation_receipts (
           caller_fingerprint, request_id, method, payload_hash, state, receipt
         ) VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          params.callerFingerprint,
          params.requestId,
          params.method,
          params.payloadHash,
          material ? JSON.stringify({ materialTarget: material }) : null
        )
      const row = this.getMutationReceipt(params.callerFingerprint, params.requestId)
      this.db.exec('COMMIT')
      return { disposition: 'started', row: row as MutationReceiptRow }
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    } finally {
      if (material && typeof priorSync === 'number' && [0, 1, 2, 3].includes(priorSync)) {
        this.db.pragma(`synchronous = ${priorSync}`)
      }
    }
  }

  materialPendingTargets(this: OrchestrationDb): MaterialManifest[] | null {
    const rows = this.db
      .prepare(
        "SELECT request_id, receipt FROM mutation_receipts WHERE method = 'worktree.materialRestore' AND state = 'pending' LIMIT 1025"
      )
      .all()
    if (rows.length > 1024) {
      return null
    }
    const claims: MaterialManifest[] = []
    for (const row of rows) {
      if (typeof row.receipt !== 'string' || Buffer.byteLength(row.receipt) > 32_768) {
        return null
      }
      try {
        const value: unknown = JSON.parse(row.receipt)
        if (
          !value ||
          typeof value !== 'object' ||
          !('materialTarget' in value) ||
          Object.keys(value).length !== 1
        ) {
          return null
        }
        const parsed = WorktreeMaterialRestore.safeParse({
          requestId: row.request_id,
          manifest: value.materialTarget
        })
        if (!parsed.success) {
          return null
        }
        claims.push(parsed.data.manifest)
      } catch {
        return null
      }
    }
    return claims
  }

  close(): void {
    this.db.close()
  }
}

export type OrchestrationDb = OrchestrationDbCore & OrchestrationDbMethods

attachOrchestrationDbMethods(OrchestrationDbCore)

// Why: attach adds methods on the prototype; oxlint forbids class/interface merging, so the construct type is asserted.
export const OrchestrationDb = OrchestrationDbCore as new (
  dbPath: (string & {}) | ':memory:'
) => OrchestrationDb
