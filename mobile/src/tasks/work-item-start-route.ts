import { preflightWorkItemStart } from '../../../src/shared/work-item-start-preflight'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { settingsRead } from '../transport/settings-read-operations'
import { structuredAgentSupportProbe } from '../session/mobile-session-launch-operations'
import { worktreeCreateCapabilityRead } from './mobile-workspace-create-operations'
import { admitWorkItemStartStorage } from './work-item-start-recovery'
import { mobileWorkItemStartCreateParams } from './work-item-start-delivery'

export async function resolveMobileWorkItemStartRoute(
  client: RpcClient,
  repoId: string,
  agent: string | undefined,
  storage: { hostId: string; prompt: string }
) {
  if (!agent || agent === 'blank') return { kind: 'manual' as const }
  const generation = client.getGeneration?.()
  const settings = settingsRead.interpret(await settingsRead.request(client))
  if (!settings.accepted) {
    throw new Error(
      'Work Item Start settings could not be confirmed. Check the connection and retry.'
    )
  }
  const value: unknown = settings.value
  const delivery =
    value && typeof value === 'object' && 'workItemStartPromptDelivery' in value
      ? value.workItemStartPromptDelivery
      : undefined
  const result = (reply: RpcResponse): unknown => {
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result
  }
  const route = await preflightWorkItemStart({
    delivery,
    agent,
    repoId,
    mobile: true,
    readStatus: async () =>
      result(await worktreeCreateCapabilityRead.request(client, undefined, { timeoutMs: 10_000 })),
    readSupport: async (params) =>
      result(await structuredAgentSupportProbe.request(client, params, { timeoutMs: 10_000 }))
  })
  if (generation !== client.getGeneration?.())
    throw new Error(
      'The connection changed during Work Item Start preflight. Retry on the current host.'
    )
  if (route.kind === 'unknown' || route.kind === 'refused') throw new Error(route.message)
  if (route.kind === 'structured' && (agent === 'claude' || agent === 'codex')) {
    await admitWorkItemStartStorage(
      storage.hostId,
      mobileWorkItemStartCreateParams('', agent, storage.prompt)
    )
    if (generation !== client.getGeneration?.())
      throw new Error('The connection changed during Work Item Start storage admission.')
  }
  return route
}
