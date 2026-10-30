import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from './agent-session-create-capabilities'
import { resolveWorkItemStartPromptDelivery } from './work-item-start-prompt-delivery'
import { WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY } from './work-item-start-structured-session-capability'

export type WorkItemStartPreflight =
  | { kind: 'manual' }
  | { kind: 'structured' }
  | { kind: 'refused' | 'unknown'; message: string }

export async function preflightWorkItemStart(args: {
  delivery: unknown
  agent: string | null | undefined
  repoId: string
  mobile?: boolean
  readStatus: () => Promise<unknown>
  readSupport: (params: { repo: string; agent: string; launchOrigin: 'work-item-start' }) => Promise<unknown>
}): Promise<WorkItemStartPreflight> {
  if (!args.agent || args.agent === 'blank' || resolveWorkItemStartPromptDelivery(args.delivery) === 'draft') {
    return { kind: 'manual' }
  }
  const refused = (): WorkItemStartPreflight => ({
    kind: 'refused',
    message: 'This host cannot confirm Work Item Start support for this agent and client. Update the host or choose Draft.'
  })
  const unknown = (): WorkItemStartPreflight => ({
    kind: 'unknown',
    message: 'Work Item Start support could not be confirmed. Check the connection and retry.'
  })
  if (args.mobile && args.agent !== 'claude' && args.agent !== 'codex') return refused()
  try {
    const status = await args.readStatus()
    if (!status || typeof status !== 'object' || !('capabilities' in status) || !Array.isArray(status.capabilities)) {
      return unknown()
    }
    if (!status.capabilities.includes(WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY) ||
        !status.capabilities.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)) {
      return refused()
    }
    const support = await args.readSupport({
      repo: `id:${args.repoId}`,
      agent: args.agent,
      launchOrigin: 'work-item-start'
    })
    if (!support || typeof support !== 'object' || !('supported' in support)) {
      return unknown()
    }
    return support.supported === true
      ? { kind: 'structured' }
      : support.supported === false ? refused() : unknown()
  } catch {
    return unknown()
  }
}
