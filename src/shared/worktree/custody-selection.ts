import { z } from 'zod'

export const WORKTREE_SELECTION_CAPABILITY = 'workspace.selection.v1' as const

export const WorktreeSelectionReportSchema = z
  .object({
    protocol: z.literal(WORKTREE_SELECTION_CAPABILITY),
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
