import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const CanonicalPromptPayloadHash = z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/)

export const MutationPromptLocator = z.object({
  terminal: z.string().min(1).optional(),
  processIncarnation: z.string().min(1).optional(),
  generation: z.number().int().nonnegative().optional(),
  provider: z.enum(['claude', 'codex', 'unsupported', 'old-host']).optional()
})

export const RequestShowParams = z
  .object({
    request: requiredString('Missing --request').optional(),
    method: z.literal('terminal.send').optional(),
    payloadHash: CanonicalPromptPayloadHash.optional(),
    prompt: MutationPromptLocator.optional(),
    currentTerminal: z.string().min(1).optional(),
    providerSessionId: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    const lookup = value.method !== undefined || value.payloadHash !== undefined
    if (
      value.request ? lookup || value.prompt !== undefined : !value.method || !value.payloadHash
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Use --request or --method terminal.send with the complete --payload-hash base:binding.'
      })
    }
    if (value.providerSessionId && !value.currentTerminal) {
      ctx.addIssue({ code: 'custom', message: '--provider-session requires --current-terminal.' })
    }
  })
