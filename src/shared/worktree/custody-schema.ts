import { z } from 'zod'

const identity = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes('\0'))
export const WorktreeCustodyResourceSchema = z
  .object({
    worktreeId: identity,
    path: identity,
    instanceId: identity,
    hostId: identity,
    owner: identity,
    product: identity,
    task: identity,
    generation: identity
  })
  .strict()

const WorktreeCustodyFenceSchema = z
  .object({
    resource: WorktreeCustodyResourceSchema,
    token: z.string().uuid(),
    authorityId: z.string().uuid(),
    capturedAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative()
  })
  .strict()

const key = z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/)
export const WorktreeCustodyRequestSchema = z.discriminatedUnion('operation', [
  z.object({ schemaVersion: z.literal(1), operation: z.literal('list') }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('observe'),
      resource: WorktreeCustodyResourceSchema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('capture'),
      resource: WorktreeCustodyResourceSchema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('check'),
      fence: WorktreeCustodyFenceSchema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('cancel'),
      fence: WorktreeCustodyFenceSchema
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('retire'),
      fence: WorktreeCustodyFenceSchema,
      key
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      operation: z.literal('reconcile'),
      resource: WorktreeCustodyResourceSchema,
      key
    })
    .strict()
])
