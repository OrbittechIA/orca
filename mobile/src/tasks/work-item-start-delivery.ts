import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../../src/shared/structured-agent-session-create'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-send-mutation'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import type { RpcClient } from '../transport/rpc-client'
import {
  readWorkItemStartRecovery,
  retainWorkItemStartCreate,
  confirmWorkItemStartCreate
} from './work-item-start-recovery'

export async function deliverMobileWorkItemStart(args: {
  client: RpcClient
  hostId: string
  worktreeId: string
  agent: string
  prompt: string
}): Promise<string | undefined> {
  const generation = args.client.getGeneration?.()
  const recovery = await readWorkItemStartRecovery(args.worktreeId, args.hostId)
  if (recovery.kind === 'legacy') return recovery.message
  if (recovery.kind === 'confirmed')
    return 'Work Item Start already created a conversation in this workspace.'
  if (recovery.kind === 'create')
    return 'Work Item Start has an unconfirmed saved create. Review the existing conversation before sending anything.'
  if (!isAgentSessionHandleProvider(args.agent)) {
    return 'This agent cannot receive a Work Item Start in a structured session.'
  }
  const params = mobileWorkItemStartCreateParams(args.worktreeId, args.agent, args.prompt)
  await retainWorkItemStartCreate(args.worktreeId, args.hostId, params)
  if (generation !== args.client.getGeneration?.()) {
    return 'The connection changed during Work Item Start. Its saved identity is retained; review the existing workspace before sending anything.'
  }
  const result = await createMobileStructuredAgentSession(
    args.client,
    args.worktreeId,
    args.agent,
    params
  )
  if (result.kind === 'created')
    await confirmWorkItemStartCreate(args.worktreeId, args.hostId, result.sessionId)
  // A create receipt proves ownership by the host; first-message delivery is shown by its official chat ledger.
  return result.kind === 'created'
    ? undefined
    : result.kind === 'unsupported'
      ? 'Work Item Start was not admitted. Its saved create can be reviewed in this workspace.'
      : result.message
}

export function mobileWorkItemStartCreateParams(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  prompt: string
) {
  return structuredAgentSessionCreateParams({
    sessionId: createStructuredAgentSessionId(agent, randomV4Uuid),
    worktree: `id:${worktreeId}`,
    agent,
    launchOrigin: 'work-item-start',
    firstMessage: {
      clientMessageId: structuredSessionOperationId(),
      body: structuredAgentSessionSendBody(prompt, [])
    },
    randomUuid: randomV4Uuid
  })
}
