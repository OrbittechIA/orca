import {
  supportsStructuredAgentSessions,
  clientRendersStructuredAgent
} from './structured-agent-session-audience'
export {
  supportsStructuredAgentSessions,
  clientRendersStructuredAgent,
  clientReadsStructuredSessionAgent
} from './structured-agent-session-audience'
import { AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import { STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY } from '../../../../shared/protocol-version'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import {
  isNativeChatDefaultFor,
  isNativeChatEnabled
} from '../../../../shared/structured-native-chat-launch-route'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { readAgentLaunchModeSettings } from '../../../agent-launch/agent-launch-mode'
import type { RpcContext } from '../core'

export function clientReadsOptionsWithoutModel(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY) === true
  )
}

/** History opens Claude/Codex for any structured-capable client; other agents require explicit rendering support. */
export function clientOpensStructuredChatFromHistory(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agent: string
): boolean {
  return (
    supportsStructuredAgentSessions(context) &&
    (context.clientKind === undefined ||
      isAgentSessionHandleProvider(agent) ||
      clientRendersStructuredAgent(context.clientCapabilities, agent))
  )
}

/** Scope offers to readable registered/saved agents; undefined means all are readable and one unscoped fence applies. */
export function structuredAgentsReadBy(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>,
  agents: readonly string[]
): ((agent: string) => boolean) | undefined {
  if (context.clientKind === undefined) {
    return undefined
  }
  const reads = (agent: string) => clientRendersStructuredAgent(context.clientCapabilities, agent)
  return agents.every(reads) ? undefined : reads
}

/**
 * COMPAT(released phones): a remote client that does not pick each launch's mode itself reads
 * `agentSession.createSupport` as "should this launch be a chat", which the host's setting
 * answered. Remove once the oldest supported phone build launches agents through `agent.launch`.
 */
export function createSupportFollowsHostSetting(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind !== undefined &&
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY) !==
      true
  )
}

/** This host's resolved preference; session audience remains independent of new launches. */
export function isStructuredNativeChatDefaultFor(
  runtime: Parameters<typeof readAgentLaunchModeSettings>[0],
  agent: string
): boolean {
  const settings = readAgentLaunchModeSettings(runtime)
  return isTuiAgent(agent) ? isNativeChatDefaultFor(settings, agent) : isNativeChatEnabled(settings)
}

export function clientRequestsCommands(ctx: Pick<RpcContext, 'clientCapabilities'>): boolean {
  return ctx.clientCapabilities?.includes(AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY) === true
}
