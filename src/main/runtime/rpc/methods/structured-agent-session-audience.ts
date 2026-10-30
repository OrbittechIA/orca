import type { RpcContext } from '../core'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session-runtime-capabilities'
import {
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/structured-agent-session-surface-capabilities'

export function supportsStructuredAgentSessions(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
}

export function clientRendersStructuredAgent(
  clientCapabilities: readonly RuntimeCapability[] | undefined,
  agent: string
): boolean {
  if (!clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return false
  }
  if (agent === 'codex') {
    return true
  }
  if (agent === 'pi' && !clientCapabilities.includes(PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY)) {
    return false
  }
  return clientCapabilities.includes(
    agent === 'claude'
      ? CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      : STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}

export function clientReadsStructuredSessionAgent(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agent: string
): boolean {
  return (
    agent !== 'pi' ||
    context.clientKind === undefined ||
    clientRendersStructuredAgent(context.clientCapabilities, agent)
  )
}
