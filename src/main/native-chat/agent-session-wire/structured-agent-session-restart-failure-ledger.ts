// Keep actionable failures after offers are spent; retire on independent startup, successful retry or dismissal.

import type { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import type {
  AgentSessionResumeFailureInput,
  AgentSessionResumeFailureRecord
} from '../../runtime/agent-session-recovery-capsule-entries'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type {
  AgentSessionResumeFailureOutcome,
  AgentSessionResumeMarker
} from '../../../shared/agent-session-resume-marker'
import { normalizeOptionalField } from '../../../shared/agent-status-field-normalization'
import { AGENT_MODEL_MAX_LENGTH } from '../../../shared/agent-status-types'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionRestartReach,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'
import {
  STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE,
  type StructuredAgentSessionResumeOutcome
} from './structured-agent-session-restart-resume-runner'
import { RESTART_CONTINUATION_SUPERSEDED } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

type FailureCapsule = Pick<
  AgentSessionRecoveryCapsule,
  'listFailed' | 'completeResume' | 'failResume' | 'rollbackResume' | 'dismiss' | 'clearAll'
>

export type StructuredAgentSessionRestartFailureLedger = {
  read: () => Promise<AgentSessionResumeFailureRecord[]>
  /** Saved failure rows a surface can show; retry eligibility is checked separately. */
  list: () => Promise<StructuredAgentSessionResumeFailure[]>
  /** File failures or complete reservations, then reopen only rows still owned by this action. */
  settle: (
    operationId: string,
    outcomes: readonly StructuredAgentSessionResumeOutcome[],
    action: {
      candidates: readonly StructuredAgentSessionResumeCandidate[]
      /** Retain marker message IDs for older readers. */
      markers: ReadonlyMap<string, AgentSessionResumeMarker>
      /** Continuation outcome decides failure; reattachment alone proves no delivery. */
      failureAfterResume: (sessionId: string) => AgentSessionResumeFailureOutcome | null
      failureReason: (sessionId: string) => string
    }
  ) => Promise<void>
  /** Dismiss only visible agents/reachable records; unnamed dismissal preserves newer chats and fences what it removed. */
  dismiss: (
    sessionIds: readonly string[] | undefined,
    beforeClearAll: (
      audience?: StructuredAgentSessionRestartAudience,
      reach?: StructuredAgentSessionRestartReach
    ) => void | Promise<void>,
    audience?: StructuredAgentSessionRestartAudience,
    reach?: StructuredAgentSessionRestartReach
  ) => Promise<number>
}

export function continuationFailureOutcome(
  outcome: StructuredAgentSessionContinuationOutcome['outcome']
): AgentSessionResumeFailureOutcome | null {
  return outcome === 'continued' ? null : outcome === 'refused' ? 'refused' : 'unconfirmed'
}

export function createStructuredAgentSessionRestartFailureLedger(deps: {
  capsule?: FailureCapsule
  getRecord: (sessionId: string) => AgentSessionConversationView | null
  retryable: (marker: AgentSessionResumeMarker) => boolean
  /** Preserve newer-chat failures for compatible builds, hidden here. */
  savedByNewerOrca: (sessionId: string) => boolean
  logger: StructuredAgentSessionLogger
  now: () => number
  /** Share the capsule mutation lane with offer operations. */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>
}): StructuredAgentSessionRestartFailureLedger {
  const read = async (): Promise<AgentSessionResumeFailureRecord[]> => {
    try {
      return (await deps.capsule?.listFailed(deps.now())) ?? []
    } catch {
      // Advisory recovery failures must not block ordinary chat.
      deps.logger.warn('reading restart failures from the recovery capsule failed', {
        scope: 'recovery-capsule-read'
      })
      return []
    }
  }

  const toRow = (
    failure: AgentSessionResumeFailureRecord
  ): StructuredAgentSessionResumeFailure[] => {
    const record = deps.getRecord(failure.marker.sessionId)
    if (!record || deps.savedByNewerOrca(failure.marker.sessionId)) {
      return []
    }
    const model = normalizeOptionalField(record.options?.model, AGENT_MODEL_MAX_LENGTH)
    return [
      {
        sessionId: failure.marker.sessionId,
        workspaceId: record.location.workspaceId,
        agent: record.provider,
        work: failure.marker.work,
        trigger: failure.marker.trigger,
        recordedAt: failure.marker.recordedAt,
        latestPrompt: failure.latestPrompt,
        executionHostId: record.location.executionHostId,
        workspaceKind: record.location.workspaceKind,
        ...(model === undefined ? {} : { model }),
        failedAt: failure.failedAt,
        outcome: failure.outcome,
        reason: failure.reason,
        ...(failure.details ? { details: failure.details } : {}),
        retryable: deps.retryable(failure.marker)
      }
    ]
  }

  const list = async (): Promise<StructuredAgentSessionResumeFailure[]> => {
    const failures = await read()
    return failures.flatMap(toRow)
  }

  const settle: StructuredAgentSessionRestartFailureLedger['settle'] = async (
    operationId,
    outcomes,
    action
  ) => {
    const capsule = deps.capsule
    if (!capsule) {
      return
    }
    const completed: string[] = []
    const failures: AgentSessionResumeFailureInput[] = []
    // Retry retains the original prompt; its rejected continuation may now be the newest message.
    const promptBySession = new Map([
      ...action.candidates.map(
        (candidate) => [candidate.sessionId, candidate.latestPrompt] as const
      ),
      ...(await read()).map((filed) => [filed.marker.sessionId, filed.latestPrompt] as const)
    ])
    for (const outcome of outcomes) {
      const resumed = outcome.outcome === 'resumed'
      // Newer-chat refusal files nothing; rollback retains the offer for a compatible build.
      if (
        !resumed &&
        outcome.reason === 'agent_session_journal_unreadable' &&
        outcome.details?.reason === 'journalWrittenByNewerOrca'
      ) {
        continue
      }
      // Ineligible/superseded offers are spent without retryable failure.
      const failure = resumed
        ? action.failureAfterResume(outcome.sessionId)
        : outcome.reason === STRUCTURED_AGENT_SESSION_RESUME_NOT_ELIGIBLE ||
            outcome.reason === RESTART_CONTINUATION_SUPERSEDED
          ? null
          : 'refused'
      if (failure === null) {
        completed.push(outcome.sessionId)
        continue
      }
      failures.push({
        sessionId: outcome.sessionId,
        failedAt: deps.now(),
        outcome: failure,
        reason: resumed
          ? action.failureReason(outcome.sessionId)
          : (outcome.reason ?? 'agent_session_resume_refused'),
        ...(!resumed && outcome.details ? { details: outcome.details } : {}),
        latestPrompt: promptBySession.get(outcome.sessionId) ?? '',
        latestUserItemId: action.markers.get(outcome.sessionId)?.latestUserItemId ?? null
      })
    }
    await deps
      .enqueue(() => capsule.completeResume(operationId, completed, deps.now()))
      .catch(() => {
        deps.logger.warn('completing a restart offer failed', {
          scope: 'restart-offer-complete',
          operationId
        })
      })
    // File failure before rollback so it cannot reopen as an automatically rerunnable offer.
    await deps
      .enqueue(() => capsule.failResume(operationId, failures, deps.now()))
      .catch(() => {
        deps.logger.warn('recording a restart failure failed', {
          scope: 'restart-failure-record',
          operationId
        })
      })
    // Rollback reopens only still-owned rows, preserving already completed removals.
    await deps
      .enqueue(() => capsule.rollbackResume(operationId, deps.now()))
      .catch(() => {
        deps.logger.warn('rolling back a restart offer failed', {
          scope: 'restart-offer-rollback',
          operationId
        })
      })
  }

  return {
    read,
    list,
    settle,
    dismiss: (sessionIds, beforeClearAll, audience, reach) =>
      deps.enqueue(async () => {
        // Under capsule lock, keep sessions whose launch scope the caller cannot prove it may act on.
        const unreachable = (marker: AgentSessionResumeMarker) =>
          reach !== undefined && !reach(marker.sessionId)
        if (audience) {
          // Under capsule lock, keep unreadable/unshown agents and newer chats outside this audience.
          const hidden = (marker: AgentSessionResumeMarker) => {
            const record = deps.getRecord(marker.sessionId)
            return (
              record === null ||
              !audience(record.provider) ||
              unreachable(marker) ||
              (sessionIds === undefined && deps.savedByNewerOrca(marker.sessionId))
            )
          }
          if (sessionIds !== undefined) {
            return (await deps.capsule?.dismiss(sessionIds, deps.now(), hidden)) ?? 0
          }
          await beforeClearAll(audience, reach)
          // A teardown writer from another process may publish late; fence only what this dismissal removed.
          return (await deps.capsule?.dismiss('all', deps.now(), hidden, 'dismissed-sessions')) ?? 0
        }
        if (sessionIds !== undefined) {
          return (await deps.capsule?.dismiss(sessionIds, deps.now(), unreachable)) ?? 0
        }
        await beforeClearAll(undefined, reach)
        // Dismiss only shown records; newer chats belong to compatible builds.
        const keep = (marker: AgentSessionResumeMarker) =>
          deps.savedByNewerOrca(marker.sessionId) || unreachable(marker)
        return (
          (await deps.capsule?.clearAll(deps.now(), keep, reach ? 'dismissed-sessions' : 'all')) ??
          0
        )
      })
  }
}
