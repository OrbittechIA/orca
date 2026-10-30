import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { reserveStructuredLaunchSlot } from './structured-agent-session-launch-surface'
import {
  setStructuredLaunchState,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  launchAndReconcile,
  type StructuredAgentLaunchReceipt
} from './agent-session/launch/structured-agent-session-launch-recovery'
import type { StructuredAgentLaunchOptions } from './structured-agent-session-launch-callers'

export function applyStructuredLaunchOrigin(
  intent: StructuredLaunchState['intent'],
  launchOrigin: StructuredAgentLaunchOptions['launchOrigin']
): void {
  if (launchOrigin) {
    const params = { ...intent.params, launchOrigin }
    intent.params = {
      ...params,
      envelope: {
        ...params.envelope,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId: intent.sessionId,
          ...params
        })
      }
    }
  }
}

export function beginStructuredLaunch(
  state: StructuredLaunchState,
  launchOrigin: StructuredAgentLaunchOptions['launchOrigin']
): Promise<StructuredAgentLaunchReceipt> {
  try {
    setStructuredLaunchState(state, launchOrigin !== undefined)
    reserveStructuredLaunchSlot(state.intent)
    return launchAndReconcile(state)
  } catch (error) {
    if (!launchOrigin) {
      throw error
    }
    return Promise.reject(error)
  }
}
