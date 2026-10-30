export async function readLegacyWorkItemStartRecovery(
  storage: { getItem(key: string): Promise<string | null> },
  worktreeId: string
): Promise<{ kind: 'none' } | { kind: 'legacy'; message: string }> {
  // Never rewrite 224 journals or convert a possibly submitted separate send into firstMessage.
  for (const [key, field] of [
    ['orca:mobileWorkItemStartAttempts:v1', 'attempts'],
    ['orca:mobileWorkItemStartSendIdentities:v1', 'identities']
  ] as const) {
    const raw = await storage.getItem(key)
    if (raw === null) continue
    const journal: unknown = JSON.parse(raw)
    if (!journal || typeof journal !== 'object' || !('v' in journal) || journal.v !== 1 || !(field in journal)) {
      throw new Error('Earlier Work Item Start recovery data is unreadable. Review the existing conversation before sending anything.')
    }
    const entries: unknown = Reflect.get(journal, field)
    if (!Array.isArray(entries) || entries.some((entry: unknown) =>
      !entry || typeof entry !== 'object' || !('worktreeId' in entry) || typeof entry.worktreeId !== 'string')) {
      throw new Error('Earlier Work Item Start recovery data is unreadable. Review the existing conversation before sending anything.')
    }
    if (entries.some((entry: { worktreeId: string }) => entry.worktreeId === worktreeId)) {
      return { kind: 'legacy', message: 'An earlier Work Item Start needs recovery. Its session, create and send identities are retained; delivery is unconfirmed. Review the existing conversation before sending anything.' }
    }
  }
  return { kind: 'none' }
}
