import { z } from 'zod'

const text = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => value.trim().length > 0)
const timestamp = z.iso.datetime({ precision: 3 })
export const HumanGateFingerprint = z.string().regex(/^[0-9a-f]{64}$/)
export const HumanGateIdentitySchema = z.strictObject({
  run_id: text,
  task_id: text,
  canonical_product: text,
  mission_id: text,
  registration_id: text,
  contract_id: text
})
export const HumanGateReferenceSchema = z.strictObject({
  gate_id: text,
  request_fingerprint: HumanGateFingerprint
})
export const HumanGateRequestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    revision: z.number().int().positive(),
    identity: HumanGateIdentitySchema,
    requested_at: timestamp,
    expires_at: timestamp.nullable(),
    requester: z.strictObject({
      kind: z.enum(['human', 'agent', 'service']),
      id: text,
      dispatch_id: text.nullable()
    }),
    source: z.strictObject({ system: text, version: text }),
    reason: text,
    risk: text,
    scope: text,
    subject: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('pull_request'),
        provider: text,
        repository: text,
        number: z.number().int().positive(),
        head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      }),
      z.strictObject({ kind: z.literal('operation'), id: text })
    ]),
    allows: z.array(text).min(1).max(128),
    does_not_allow: z.array(text).min(1).max(128),
    evidence: z
      .array(z.strictObject({ ref: text, description: text, digest: text.nullable() }))
      .max(128),
    supersedes: HumanGateReferenceSchema.nullable()
  })
  .refine((request) => request.expires_at === null || request.expires_at > request.requested_at, {
    message: 'Expiry must follow request time'
  })
export const HumanGatePrincipalSchema = z.strictObject({ authority: text, subject_id: text })
export const HumanGateDecisionSchema = HumanGateReferenceSchema.extend({
  decision: z.enum(['approved', 'rejected'])
})
export const HumanGateReceiptSchema = HumanGateDecisionSchema.extend({
  schema_version: z.literal(1),
  principal: HumanGatePrincipalSchema,
  decided_at: timestamp,
  receipt_fingerprint: HumanGateFingerprint
})
export const HumanGateRetirementSchema = HumanGateReferenceSchema.extend({
  state: z.enum(['superseded', 'expired']),
  recorded_at: timestamp,
  reason: text,
  successor: HumanGateReferenceSchema.nullable()
})
export type HumanGateIdentity = z.infer<typeof HumanGateIdentitySchema>
export type HumanGateRequest = z.infer<typeof HumanGateRequestSchema>
export type HumanGateDecision = z.infer<typeof HumanGateDecisionSchema>
export type HumanGatePrincipal = z.infer<typeof HumanGatePrincipalSchema>
export type HumanGateReceipt = z.infer<typeof HumanGateReceiptSchema>
export type HumanGateRetirement = z.infer<typeof HumanGateRetirementSchema>
export type HumanGateRecord = {
  gate_id: string
  request_fingerprint: string
  request: HumanGateRequest
  state: 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired'
  receipt: HumanGateReceipt | null
  retirement: HumanGateRetirement | null
}
export type HumanGateProjection = {
  schema_version: 1
  identity: HumanGateIdentity
  coverage: 'complete' | 'partial' | 'unavailable'
  reasons: string[]
  gates: HumanGateRecord[]
}
