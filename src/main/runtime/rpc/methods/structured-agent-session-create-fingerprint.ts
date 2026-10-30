import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionResumeSource,
  StructuredAgentSessionLaunchOrigin,
  StructuredAgentSessionFirstMessage
} from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionCreateFingerprint } from '../../../../shared/structured-agent-session-mutation'

/** New creates keep the immutable client intent in the ledger; legacy creates keep attach identity. */
export function structuredAgentSessionCreateIntentFingerprint(params: {
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: string
  resumeFrom?: StructuredAgentSessionResumeSource
  launchOrigin?: StructuredAgentSessionLaunchOrigin
  tabId?: string
  firstMessage?: StructuredAgentSessionFirstMessage
  optionsMode?: 'replace-model-selection'
  options?: Readonly<Record<string, string>>
}): string {
  return structuredAgentSessionCreateFingerprint({
    ...params,
    sessionId: params.envelope.sessionId
  })
}
