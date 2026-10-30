export const WORK_ITEM_START_CREATE_STORAGE_PREFIX = 'orca:mobileWorkItemStartCreate:'
export const WORK_ITEM_START_ADMISSION_STORAGE_PREFIX = 'orca:mobileWorkItemStartAdmission:'

export function workItemStartCreateStorageKey(hostId: string, worktreeId: string): string {
  return `${WORK_ITEM_START_CREATE_STORAGE_PREFIX}${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
}

export function workItemStartAdmissionStorageKey(hostId: string): string {
  return `${WORK_ITEM_START_ADMISSION_STORAGE_PREFIX}${encodeURIComponent(hostId)}`
}

export function isWorkItemStartWorkspaceStorageKeyForHost(key: string, hostId: string): boolean {
  const prefix = `${WORK_ITEM_START_CREATE_STORAGE_PREFIX}${encodeURIComponent(hostId)}:`
  return key.startsWith(prefix) && key.length > prefix.length
}

export function isWorkItemStartStorageKey(key: string): boolean {
  return key.startsWith(WORK_ITEM_START_CREATE_STORAGE_PREFIX) ||
    key.startsWith(WORK_ITEM_START_ADMISSION_STORAGE_PREFIX) ||
    key === 'orca:mobileWorkItemStartCreates:v1' ||
    key === 'orca:mobileWorkItemStartAttempts:v1' ||
    key === 'orca:mobileWorkItemStartSendIdentities:v1'
}
