// Bounded provider option bag, plus Work Item Start's slice of the launch vocabulary.
// The validator lives here rather than in `agent-session-record.ts` so that file stays
// under the size limit; the record imports it back.

const MAX_OPTION_KEY_LENGTH = 512

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function isAgentSessionOptions(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, option]) =>
        isBoundedString(key, MAX_OPTION_KEY_LENGTH) &&
        isBoundedString(option, MAX_OPTION_KEY_LENGTH)
    )
  )
}

/**
 * Work Item Start's slice of the launch vocabulary.
 *
 * The full vocabulary is the renderer's `NativeChatLaunchPromptDelivery`
 * (`'auto-submit' | 'draft' | 'submit-after-ready'`). This is deliberately a
 * NARROWING of it, not a second vocabulary: Work Item Start never offers
 * `auto-submit`, because a Start that submits before authoritative readiness is
 * exactly the double-writer risk this feature exists to avoid. Values assign
 * straight into the official union; `shared` cannot import from the renderer, so
 * the subset is declared here rather than re-exported.
 */
export type WorkItemStartPromptDelivery = 'draft' | 'submit-after-ready'

/** `draft` is the safe default: unsent text never becomes an unattended turn. */
export const DEFAULT_WORK_ITEM_START_PROMPT_DELIVERY: WorkItemStartPromptDelivery = 'draft'

export function resolveWorkItemStartPromptDelivery(value: unknown): WorkItemStartPromptDelivery {
  return value === 'submit-after-ready' ? 'submit-after-ready' : 'draft'
}
