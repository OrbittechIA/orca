import { z } from 'zod'

const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Sha = z.string().regex(/^[a-f0-9]{40}$/)
const Locator = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\x00-\x1f]+$/)
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
      .regex(/^[^\x00-\x20]+$/),
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
