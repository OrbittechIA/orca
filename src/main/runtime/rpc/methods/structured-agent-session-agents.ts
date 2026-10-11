// `agentSession.agents` — the structured agents this host registered, with each agent's declared
// capability record, so a client can show what an agent supports before a session of it exists.
//
// Additive and negotiated: a client calls it only once the host advertises
// `agent-session.structured.registered-agents.v1`; without it, a client knows Claude and Codex only.

import type { AgentSessionAgentsResult } from '../../../../shared/agent-session-registered-agents'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../../shared/agent-session-registered-agents'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../../structured-agent-runtime-registrations'
import { defineMethod } from '../core'
import { supportsStructuredSessions } from './structured-agent-session-gate'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { AgentsParams } from './structured-agent-session-schemas'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

export const STRUCTURED_AGENT_SESSION_AGENTS_METHODS = [
  defineMethod({
    name: AGENT_SESSION_AGENTS_METHOD,
    permission: 'workspace',
    params: AgentsParams,
    // Read from the registrations the host is built from, as createSupport is: the answer is
    // fixed for this build, so it never waits on, or fails with, installing the host.
    handler: async (_params, ctx): Promise<AgentSessionAgentsResult> => {
      if (!supportsStructuredSessions(ctx)) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      return {
        agents: STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(({ definition }) =>
          clientReadsStructuredSessionAgent(ctx, definition.agent)
        ).map(({ definition }) => ({
          agent: definition.agent,
          capabilities: { ...definition.capabilities }
        }))
      }
    }
  })
]
