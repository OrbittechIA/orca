import { z } from 'zod'
import { WorktreeCustodyFenceSchema } from './custody-schema'
import { parseRoutableExecutionHostId } from '../execution-host'

export const WORKTREE_SELECTION_CAPABILITY = 'workspace.selection.v1' as const
export const WORKTREE_SELECTION_BRIDGE_CAPABILITY = 'workspace.selection.bridge.v1' as const

export const SelectionBootstrapSchema = z
  .object({
    protocol: z.literal(WORKTREE_SELECTION_BRIDGE_CAPABILITY),
    scopes: z
      .array(
        z
          .object({
            executionHost: z
              .string()
              .min(1)
              .max(1024)
              .refine((value) => parseRoutableExecutionHostId(value)?.kind === 'runtime')
              .nullable(),
            fences: z.array(WorktreeCustodyFenceSchema).max(64)
          })
          .strict()
      )
      .max(64)
  })
  .strict()
  .refine(
    (value) =>
      value.scopes.reduce((sum, scope) => sum + scope.fences.length, 0) <= 64 &&
      new Set(value.scopes.map((scope) => scope.executionHost)).size === value.scopes.length
  )
export type SelectionBootstrap = z.infer<typeof SelectionBootstrapSchema>

export const WorktreeSelectionReportSchema = z
  .object({
    protocol: z.literal(WORKTREE_SELECTION_CAPABILITY),
    kind: z.enum(['view', 'headless']).default('view'),
    complete: z.boolean().default(true),
    workspaceIds: z
      .array(
        z
          .string()
          .min(1)
          .max(8192)
          .refine((id) => !id.includes('\0'))
      )
      .max(64)
  })
  .strict()

const nonce = z.string().uuid()
const connectionId = z.string().min(1).max(1024)
export const SelectionRoundSchema = z
  .object({
    nonce,
    channelNonce: nonce,
    clientIncarnation: nonce,
    connectionId,
    fence: WorktreeCustodyFenceSchema
  })
  .strict()
export const SelectionWatchSchema = WorktreeSelectionReportSchema.extend({
  kind: z.literal('view').default('view'),
  clientIncarnation: nonce,
  pendingFences: z.array(WorktreeCustodyFenceSchema).max(64)
}).strict()
export const SelectionAckSchema = SelectionRoundSchema.extend({
  disposition: z.enum(['absent', 'held', 'unknown'])
}).strict()
export const SelectionReconcileSchema = z
  .object({
    channelNonce: nonce,
    fences: z.array(WorktreeCustodyFenceSchema).max(64)
  })
  .strict()
export const SelectionUnsubscribeSchema = z
  .object({ subscriptionId: z.string().min(1).max(2048) })
  .strict()
export const SelectionFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      channelNonce: nonce,
      clientIncarnation: nonce,
      connectionId,
      subscriptionId: z.string().min(1).max(2048).optional()
    })
    .strict(),
  z.object({ type: z.literal('end') }).strict(),
  z.object({ type: z.literal('fence'), round: SelectionRoundSchema }).strict(),
  z
    .object({ type: z.literal('hold'), channelNonce: nonce, fence: WorktreeCustodyFenceSchema })
    .strict(),
  z
    .object({
      type: z.literal('settled'),
      channelNonce: nonce,
      fence: WorktreeCustodyFenceSchema,
      proof: z.string().min(1).max(8192)
    })
    .strict()
])
export type SelectionRound = z.infer<typeof SelectionRoundSchema>
export type SelectionAck = z.infer<typeof SelectionAckSchema>
export type SelectionFrame = z.infer<typeof SelectionFrameSchema>
