import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizePRBotAuthorOverrides } from '../../../../shared/pr-bot-author-overrides'
import { normalizeWorktreeVisibilityDefaults } from '../../../../shared/external-worktree-visibility'

/**
 * Which settings cross between this client and the host it is paired with.
 *
 * This lives on its own because getting the list wrong is not a cosmetic bug. A field the
 * host enforces but this client never mirrors leaves the two disagreeing about which code
 * path to take — which is how a Work Item Start came to drop its terminal startup for a
 * structured session the host then refused, leaving a workspace with no writer.
 */

/**
 * Settings the HOST decides. Omitting one here, or reporting a failed write as saved, makes
 * the client act on a value the host does not hold.
 */
export const HOST_ENFORCED_SETTING_KEYS = ['workItemStartPromptDelivery'] as const

export type HostEnforcedSettingKey = (typeof HOST_ENFORCED_SETTING_KEYS)[number]

export function hostEnforcedSettingsInUpdate(
  updates: Partial<GlobalSettings>
): HostEnforcedSettingKey[] {
  return HOST_ENFORCED_SETTING_KEYS.filter((key) => updates[key] !== undefined)
}

/** The subset of a client-side change that the host is allowed to be told about. */
export function runtimeSettingsUpdatePayload(
  updates: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  const payload: Partial<GlobalSettings> = {}
  const visibilityDefaults = normalizeWorktreeVisibilityDefaults(updates.worktreeVisibilityDefaults)
  if (visibilityDefaults) {
    payload.worktreeVisibilityDefaults = visibilityDefaults
  }
  if (
    updates.workItemStartPromptDelivery === 'submit-after-ready' ||
    updates.workItemStartPromptDelivery === 'draft'
  ) {
    payload.workItemStartPromptDelivery = updates.workItemStartPromptDelivery
  }
  if (typeof updates.experimentalNewWorktreeCardStyle === 'boolean') {
    payload.experimentalNewWorktreeCardStyle = updates.experimentalNewWorktreeCardStyle
  }
  if (typeof updates.compactWorktreeCards === 'boolean') {
    payload.compactWorktreeCards = updates.compactWorktreeCards
  }
  if (typeof updates.minimaxGroupId === 'string') {
    payload.minimaxGroupId = updates.minimaxGroupId
  }
  if (typeof updates.minimaxUsageModels === 'string') {
    payload.minimaxUsageModels = updates.minimaxUsageModels
  }
  if (updates.minimaxEndpoint === 'overseas' || updates.minimaxEndpoint === 'cn') {
    payload.minimaxEndpoint = updates.minimaxEndpoint
  }
  if (Array.isArray(updates.prBotAuthorOverrides)) {
    payload.prBotAuthorOverrides = normalizePRBotAuthorOverrides(updates.prBotAuthorOverrides)
  }
  return payload
}
