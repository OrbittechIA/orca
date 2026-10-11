import { z } from 'zod'

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Sha = z.string().regex(/^[a-f0-9]{40}$/)
const Locator = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 32))
export const MaterialRequestId = z.string().uuid()
export const WorktreeMaterialManifest = z
  .object({
    schemaVersion: z.literal(1),
    repo: z
      .string()
      .regex(/^id:[^\s:]+$/)
      .max(256),
    canonicalSource: z
      .string()
      .regex(/^[a-z0-9.-]+\/[a-zA-Z0-9._/-]+$/)
      .max(512),
    executionHostId: z.string().min(1).max(256),
    worktreeId: Locator,
    path: Locator,
    branch: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => [...value].every((char) => char.charCodeAt(0) > 32)),
    head: Sha,
    tree: Sha,
    linkedIssue: z.number().int().positive().nullable(),
    linkedReview: z.number().int().positive().nullable(),
    historicalInstanceId: MaterialRequestId.nullable(),
    runId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9:_-]+$/),
    capsuleSHA256: Digest,
    expectedMetadataDigest: Digest,
    expectedCatalogDigest: Digest.optional(),
    expectedPlanDigest: Digest.optional()
  })
  .strict()
export const WorktreeMaterialPlan = z.object({ manifest: WorktreeMaterialManifest }).strict()
export const WorktreeMaterialRestore = z
  .object({
    requestId: MaterialRequestId,
    manifest: WorktreeMaterialManifest.extend({
      expectedCatalogDigest: Digest,
      expectedPlanDigest: Digest
    })
  })
  .strict()
export const WorktreeMaterialShow = z.object({ requestId: MaterialRequestId }).strict()

export const MaterialHistoryAssertionSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionHostId: z.literal('local'),
    worktreeId: Locator,
    historicalInstanceId: MaterialRequestId.nullable(),
    requestId: MaterialRequestId,
    metadataDigest: Digest,
    historyDigest: Digest
  })
  .strict()

/** Historical material evidence only. It carries no session, lease or settlement authority. */
export const MaterialRestoredReceipt = z
  .object({
    schemaVersion: z.literal(1),
    state: z.literal('restored'),
    requestId: MaterialRequestId,
    manifest: WorktreeMaterialRestore.shape.manifest,
    adminDigest: Digest,
    indexDigest: Digest,
    historyDigest: Digest,
    historicalInstanceId: MaterialRequestId,
    instanceId: MaterialRequestId,
    coverage: z
      .object({
        git: z.literal(true),
        hostMetadata: z.literal('complete'),
        processes: z.literal('complete')
      })
      .strict(),
    retryAllowed: z.literal(false),
    writerConfirmed: z.literal(false),
    mutation: z.object({ requestId: MaterialRequestId, replayed: z.boolean() }).strict().optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.historicalInstanceId !== value.manifest.historicalInstanceId ||
      value.instanceId === value.historicalInstanceId ||
      (value.mutation && value.mutation.requestId !== value.requestId)
    ) {
      ctx.addIssue({ code: 'custom', message: 'E_MATERIAL_RECEIPT_CONFLICT' })
    }
  })
