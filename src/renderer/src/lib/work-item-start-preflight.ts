import { preflightWorkItemStart } from '../../../shared/work-item-start-preflight'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export async function requireWorkItemStartPreflight(args: {
  delivery: unknown
  agent: string | null
  repoId: string
  target: RuntimeClientTarget
}): Promise<boolean> {
  const route = await preflightWorkItemStart({
    ...args,
    readStatus: () => callRuntimeRpc(args.target, 'status.get'),
    readSupport: (params) => callRuntimeRpc(args.target, 'agentSession.createSupport', params)
  })
  if (route.kind === 'refused' || route.kind === 'unknown') {
    throw new Error(route.message)
  }
  return route.kind === 'structured'
}
