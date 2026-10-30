import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'

/** Apply the same admission to every session-bearing field before publishing a frame. */
export function projectStructuredAgentSessionStatusAudience(
  event: AgentSessionStatusEvent,
  readsSession: (sessionId: string, agent?: string) => boolean
): AgentSessionStatusEvent | null {
  if (event.type === 'snapshot') {
    return {
      ...event,
      sessions: event.sessions.filter((session) => readsSession(session.sessionId, session.agent)),
      ...(event.conversationNames
        ? {
            conversationNames: event.conversationNames.filter((note) =>
              readsSession(note.sessionId)
            )
          }
        : {}),
      ...(event.namingActiveSessionIds
        ? { namingActiveSessionIds: event.namingActiveSessionIds.filter((id) => readsSession(id)) }
        : {})
    }
  }
  return event.type === 'status' && !readsSession(event.session.sessionId, event.session.agent)
    ? null
    : event
}
