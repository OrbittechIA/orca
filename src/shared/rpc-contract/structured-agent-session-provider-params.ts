import { z } from 'zod'
import { Identifier } from './structured-agent-session-identifiers'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'

export const ProviderHandle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: Identifier('Invalid thread id') }).strict(),
  z
    .object({
      kind: z.literal('claude'),
      sessionId: Identifier('Invalid provider session id'),
      leafUuid: Identifier('Invalid leaf uuid').nullable()
    })
    .strict()
])

/** Host-registered agents; clients gate names beyond Claude/Codex on the registered-agents capability. */
export const StructuredAgent = z.string().refine(isStructuredAgentId, 'Invalid agent')
