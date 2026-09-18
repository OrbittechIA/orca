import { isUnknownRecord } from '../../../src/shared/unknown-record'
import type { RuntimeTaskSettings } from './mobile-tasks-view-state-types'

export function resolveWorkItemStartSettingsRefresh(
  previous: Pick<RuntimeTaskSettings, 'workItemStartPromptDelivery'> | null | undefined,
  refreshed: unknown
): unknown {
  if (previous?.workItemStartPromptDelivery !== 'submit-after-ready') {
    return refreshed
  }
  if (!isUnknownRecord(refreshed)) {
    return previous
  }
  const delivery = refreshed.workItemStartPromptDelivery
  if (delivery === 'draft' || delivery === 'submit-after-ready') {
    return refreshed
  }
  // Missing or malformed settings cannot revoke a known strict Start preference.
  return { ...refreshed, workItemStartPromptDelivery: previous.workItemStartPromptDelivery }
}
