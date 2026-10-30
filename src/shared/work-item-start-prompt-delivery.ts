export type WorkItemStartPromptDelivery = 'draft' | 'submit-after-ready'

export function resolveWorkItemStartPromptDelivery(value: unknown): WorkItemStartPromptDelivery {
  return value === 'submit-after-ready' ? 'submit-after-ready' : 'draft'
}
