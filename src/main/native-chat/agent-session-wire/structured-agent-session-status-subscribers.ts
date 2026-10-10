import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'

export type StructuredAgentSessionStatusSubscriber = {
  id: string
  emit: (event: AgentSessionStatusEvent) => void
}

export class StructuredAgentSessionStatusSubscribers {
  private readonly subscribers = new Map<string, StructuredAgentSessionStatusSubscriber>()
  private readonly filters = new Map<string, (sessionId: string) => boolean>()

  subscribe(
    subscriber: StructuredAgentSessionStatusSubscriber,
    includeSession: ((sessionId: string) => boolean) | undefined,
    readSnapshot: () => AgentSessionStatusSummary[]
  ): () => void {
    // Reused subscriber IDs must replace their previous scope before re-projection.
    if (includeSession) {
      this.filters.set(subscriber.id, includeSession)
    } else {
      this.filters.delete(subscriber.id)
    }
    const sessions = readSnapshot()
    this.subscribers.set(subscriber.id, subscriber)
    const snapshot = scopeStatusEvent({ type: 'snapshot', sessions }, includeSession)
    if (snapshot) {
      this.emit(subscriber, snapshot)
    }
    return () => this.unsubscribe(subscriber.id)
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.drop(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  broadcast(event: AgentSessionStatusEvent): void {
    // Map iteration skips subscribers removed after a failed delivery.
    for (const subscriber of this.subscribers.values()) {
      const scoped = scopeStatusEvent(event, this.filters.get(subscriber.id))
      if (scoped) {
        this.emit(subscriber, scoped)
      }
    }
  }

  private drop(id: string): void {
    this.subscribers.delete(id)
    this.filters.delete(id)
  }

  private emit(subscriber: StructuredAgentSessionStatusSubscriber, event: AgentSessionStatusEvent) {
    try {
      subscriber.emit(event)
    } catch {
      this.drop(subscriber.id)
    }
  }
}

// Scope every session-bearing event; an end event carries no session and always passes.
export function scopeStatusEvent(
  event: AgentSessionStatusEvent,
  includeSession: ((sessionId: string) => boolean) | undefined
): AgentSessionStatusEvent | null {
  if (!includeSession) {
    return event
  }
  switch (event.type) {
    case 'status':
      return includeSession(event.session.sessionId) ? event : null
    case 'snapshot':
      return {
        type: 'snapshot',
        sessions: event.sessions.filter((session) => includeSession(session.sessionId))
      }
    case 'end':
      return event
  }
}
