import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session-write-failure'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import {
  STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING,
  type StructuredAgentSessionSendAnswer
} from '../../../../shared/structured-agent-session-send-evidence'

export type WorkItemStartSendDisposition =
  | 'delivered'
  | 'rejected'
  | 'unused'
  | 'unknown'
  | 'cancelled'

export type WorkItemStartSendResult = {
  delivered: boolean
  deliveryUnknown?: true
  retryClientMessageId?: string
}

const UNADMITTED_SEND_ERROR_CODES = ['structured_agent_session_unsupported', 'method_not_found']

export function workItemStartSubmissionDisposition(
  submission: AgentJournalSubmission | undefined
): WorkItemStartSendDisposition {
  if (!submission || submission.reason === STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING) {
    return 'unknown'
  }
  switch (submission.dispatchState) {
    case 'accepted':
    case 'pending':
      return 'delivered'
    case 'rejected':
      return 'rejected'
    case 'unknown':
      return 'unknown'
  }
}

export function workItemStartSendDisposition(
  answer: StructuredAgentSessionSendAnswer
): WorkItemStartSendDisposition {
  if (answer.kind === 'thrown') {
    const refusal = readAgentSessionErrorRefusal(answer.error)
    return UNADMITTED_SEND_ERROR_CODES.some((code) =>
      refusal
        ? refusal.code === code
        : answer.rpcCode === code || hasRuntimeRpcErrorCode(answer.error, code)
    )
      ? 'unused'
      : 'unknown'
  }
  if (!answer.result.ok) {
    return agentSessionRefusalOperationState(answer.result.refusal.code) === 'settled-rejected'
      ? 'rejected'
      : 'unknown'
  }
  return 'queued' in answer.result.value
    ? 'delivered'
    : workItemStartSubmissionDisposition(answer.result.value.submission)
}

export function finishWorkItemStartSend(
  disposition: WorkItemStartSendDisposition,
  clientMessageId: string,
  createRetryId: () => string
): WorkItemStartSendResult {
  switch (disposition) {
    case 'delivered':
      return { delivered: true }
    case 'rejected':
      return { delivered: false, retryClientMessageId: createRetryId() }
    case 'unused':
      return { delivered: false, retryClientMessageId: clientMessageId }
    case 'cancelled':
      return { delivered: false }
    case 'unknown':
      return { delivered: false, deliveryUnknown: true }
  }
}
