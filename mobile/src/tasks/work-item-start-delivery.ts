import { createStructuredAgentSessionId, structuredAgentSessionCreateParams } from '../../../src/shared/structured-agent-session-create'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-send-mutation'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { randomV4Uuid } from '../platform/random-v4-uuid'
import { structuredSessionOperationId } from '../session/structured-session-operation-id'
import { createMobileStructuredAgentSession } from '../session/mobile-structured-agent-session-launch'
import type { RpcClient } from '../transport/rpc-client'
import { readWorkItemStartRecovery, retainWorkItemStartCreate, confirmWorkItemStartCreate } from './work-item-start-recovery'

export async function deliverMobileWorkItemStart(args: {
  client: RpcClient
  worktreeId: string
  agent: string
  prompt: string
}): Promise<string | undefined> {
  const recovery = await readWorkItemStartRecovery(args.worktreeId)
  if (recovery.kind === 'legacy') return recovery.message
  if (recovery.kind === 'create') return 'Work Item Start has an unconfirmed saved create. Review the existing conversation before sending anything.'
  if (!isAgentSessionHandleProvider(args.agent)) {
    return 'This agent cannot receive a Work Item Start in a structured session.'
  }
  const params = structuredAgentSessionCreateParams({
    sessionId: createStructuredAgentSessionId(args.agent, randomV4Uuid),
    worktree: `id:${args.worktreeId}`,
    agent: args.agent,
    launchOrigin: 'work-item-start',
    firstMessage: {
      clientMessageId: structuredSessionOperationId(),
      body: structuredAgentSessionSendBody(args.prompt, [])
    },
    randomUuid: randomV4Uuid
  })
  await retainWorkItemStartCreate(args.worktreeId, params)
  const result = await createMobileStructuredAgentSession(args.client, args.worktreeId, args.agent, params)
  if (result.kind === 'created') await confirmWorkItemStartCreate(args.worktreeId, result.sessionId)
  // A create receipt proves ownership by the host; first-message delivery is shown by its official chat ledger.
  return result.kind === 'created' ? undefined
    : result.kind === 'unsupported' ? 'Work Item Start was not admitted. Its saved create can be reviewed in this workspace.'
    : result.message
}
