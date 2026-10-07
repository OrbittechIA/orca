import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import type {
  StructuredAgentSessionLaunchOrigin,
  StructuredAgentSessionLaunchAuthority
} from '../../../../shared/structured-agent-session-create'

/**
 * One rule for every caller: can this client read structured sessions? The host's own
 * `experimentalStructuredNativeChat` is not consulted. It is the host user's launch preference,
 * and whether a new agent is a chat is decided by whoever launches it, so a paired client's
 * sessions stay reachable whatever the host's setting says. The negotiated capability is a wire
 * term, asked of remote clients only: in-process callers are the host's own build.
 */
export function supportsStructuredAgentSessions(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true
  )
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

/** An unreadable settings store reads as off, the default. */
export function isStructuredNativeChatEnabled(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): boolean {
  try {
    return runtime.getClientSettings().experimentalStructuredNativeChat === true
  } catch {
    return false
  }
}

export function supportsWorkItemStartStructuredSessionCreate(
  context: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  > & {
    runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
  },
  launchOrigin: StructuredAgentSessionLaunchOrigin | undefined
): boolean {
  if (launchOrigin !== 'work-item-start' || !structuredWorkItemStartCallerAuthority(context)) {
    return false
  }
  try {
    return context.runtime.getClientSettings().workItemStartPromptDelivery === 'submit-after-ready'
  } catch {
    return false
  }
}

export function structuredWorkItemStartCallerAuthority(
  context: Pick<
    RpcContext,
    'clientCapabilities' | 'clientKind' | 'localDesktopAuthority' | 'pairedDeviceId'
  >
): StructuredAgentSessionLaunchAuthority | null {
  if (context.clientKind !== 'runtime' || !supportsWorkItemStartClientCapability(context)) {
    return null
  }
  if (context.localDesktopAuthority === true) {
    return { kind: 'local-desktop' }
  }
  const deviceId = context.pairedDeviceId?.trim()
  return deviceId ? { kind: 'paired-device', deviceId } : null
}

export const supportsStructuredAgentSessionCapability = supportsStructuredAgentSessions

export function supportsWorkItemStartClientCapability(
  context: Pick<RpcContext, 'clientCapabilities' | 'clientKind'>
): boolean {
  return (
    supportsStructuredAgentSessions(context) ||
    context.clientCapabilities?.includes(WORK_ITEM_START_STRUCTURED_SESSION_CLIENT_CAPABILITY) ===
      true
  )
}

export function structuredNativeChatProjectionEnabled(args: {
  clientKind: RpcContext['clientKind']
  clientCapabilities: readonly RuntimeCapability[] | undefined
  structuredNativeChatEnabled: boolean
}): boolean {
  return supportsStructuredAgentSessions(args)
}
