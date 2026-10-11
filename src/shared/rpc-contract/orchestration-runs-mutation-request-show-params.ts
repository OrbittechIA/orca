import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const CanonicalPromptPayloadHash = z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/)
export const CanonicalPromptPayloadBaseHash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)

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
    payloadBaseHash: CanonicalPromptPayloadBaseHash.optional(),
    prompt: MutationPromptLocator.optional(),
    currentTerminal: z.string().min(1).optional(),
    providerSessionId: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    const lookup =
      value.method !== undefined ||
      value.payloadHash !== undefined ||
      value.payloadBaseHash !== undefined
    const hashes =
      Number(value.payloadHash !== undefined) + Number(value.payloadBaseHash !== undefined)
    if (value.request ? lookup || value.prompt !== undefined : !value.method || hashes !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Use --request or --method terminal.send with either --payload-hash base:binding or --payload-base-hash.'
      })
    }
    if (value.payloadBaseHash && (!value.prompt?.terminal || !value.prompt.processIncarnation)) {
      ctx.addIssue({
        code: 'custom',
        message: '--payload-base-hash requires historical --terminal and --process-incarnation.'
      })
    }
    if (value.providerSessionId && !value.currentTerminal) {
      ctx.addIssue({ code: 'custom', message: '--provider-session requires --current-terminal.' })
    }
  })
