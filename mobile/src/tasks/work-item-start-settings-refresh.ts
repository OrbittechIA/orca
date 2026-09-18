import { isUnknownRecord } from '../../../src/shared/unknown-record'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'

export function resolveWorkItemStartSettingsRefresh(
  previous: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined,
  refreshed: unknown
): RuntimeTaskSettings | null {
  if (!isUnknownRecord(refreshed)) {
    return null
  }
  const delivery = refreshed.workItemStartPromptDelivery
  return {
    ...refreshed,
    // Missing or malformed settings cannot revoke a known strict Start preference.
    workItemStartPromptDelivery:
      delivery === 'draft' || delivery === 'submit-after-ready'
        ? delivery
        : previous?.workItemStartPromptDelivery
  }
}
