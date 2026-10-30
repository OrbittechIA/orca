import type { AgentSessionWriteFailure } from '../../../../../shared/agent-session-write-failure'
import type { AgentSessionHistoryResult } from '../../../../../shared/agent-session-wire'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../../../shared/agent-session-journal-types'
import {
  launchStructuredAgentSession,
  type StructuredLaunchHostSeedListener
} from '@/lib/structured-agent-session-launch-create-call'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readStructuredSessionTabInventory } from '@/runtime/structured-session-tab-inventory'
import { publishStructuredAgentSessionCreateHydration } from '../../structured-agent-session-create-hydration'
import {
  StructuredAgentLaunchPersistenceError,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'

export type StructuredAgentLaunchReceipt = {
  sessionId: string
  fence: number
  firstMessage?: AgentJournalSubmission
  cursor?: AgentJournalCursor
  configurationFailure?: AgentSessionWriteFailure
}

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredAgentLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
  onVisibilityChanged?: () => void
  onHostSeed?: StructuredLaunchHostSeedListener
}

export class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchRecoveryState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

async function launchWithRecoveryRecord(
  state: StructuredLaunchRecoveryState,
  priorCreateOutcomeUnknown: boolean
): Promise<StructuredAgentLaunchReceipt> {
  const { intent } = state
  if (!intent.params.launchOrigin) {
    return launchStructuredAgentSession(
      intent,
      state.onHostSeed,
      priorCreateOutcomeUnknown,
      () => state.cancelled
    )
  }
  try {
    if (priorCreateOutcomeUnknown && !intent.params.firstMessage) {
      throw new StructuredAgentLaunchPersistenceError()
    }
    writeStructuredAgentLaunchRecord(
      structuredAgentLaunchRecordFor(
        intent,
        priorCreateOutcomeUnknown ? 'visibility-unknown' : 'pending'
      ),
      true
    )
    return await launchStructuredAgentSession(
      intent,
      state.onHostSeed,
      priorCreateOutcomeUnknown,
      () => state.cancelled
    )
  } catch (error) {
    if (error instanceof StructuredAgentLaunchPersistenceError && priorCreateOutcomeUnknown) {
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
    }
    throw error
  }
}

async function verifyPublishedSession(state: StructuredLaunchRecoveryState): Promise<void> {
  const snapshots = await readStructuredSessionTabInventory(state.intent.target)
  throwIfLaunchCancelled(state)
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === state.intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === state.intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

export async function recoverPublishedSessionReceipt(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  await verifyPublishedSession(state)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    state.intent.target,
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  const firstMessage = state.intent.params.firstMessage
    ? history.page.submissions.find(
        (submission) =>
          submission.clientMessageId === state.intent.params.firstMessage?.clientMessageId
      )
    : undefined
  if (state.intent.params.firstMessage && !firstMessage) {
    return launchWithRecoveryRecord(state, true)
  }
  if (state.intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(state.intent, history.page, fence)
  }
  return {
    sessionId: state.intent.sessionId,
    fence,
    ...(firstMessage
      ? { firstMessage, cursor: history.page.liveCursor ?? history.page.window.nextCursor }
      : {})
  }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  try {
    const receipt = await launchWithRecoveryRecord(state, true)
    throwIfLaunchCancelled(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  let receipt: StructuredAgentLaunchReceipt
  try {
    receipt = await launchWithRecoveryRecord(state, false)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch (recoveryError) {
      if (recoveryError instanceof StructuredAgentLaunchPersistenceError) {
        throw recoveryError
      }
      return retrySameIntent(state, error)
    }
  }
  throwIfLaunchCancelled(state)
  return receipt
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  state.onVisibilityChanged?.()
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch (error) {
    if (error instanceof StructuredAgentLaunchPersistenceError) {
      throw error
    }
    return retrySameIntent(state, error)
  }
}
