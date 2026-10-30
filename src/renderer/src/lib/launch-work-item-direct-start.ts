import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { requireWorkItemStartPreflight } from './work-item-start-preflight'
import { unavailableAgentErrorMessage } from './launch-work-item-direct-messages'
import {
  resolveDirectProspectiveAgent,
  type DirectLaunchOwnerRow
} from './launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from './launch-work-item-direct-types'

export async function prepareDirectWorkItemStart(
  store: Parameters<typeof resolveDirectProspectiveAgent>[0],
  owner: DirectLaunchOwnerRow,
  projectContext: Parameters<typeof resolveDirectProspectiveAgent>[2],
  args: LaunchWorkItemDirectArgs,
  promptDelivery: 'draft' | 'submit-after-ready'
) {
  const { prospectiveAgent, unavailable } = await resolveDirectProspectiveAgent(
    store,
    owner.repo,
    projectContext,
    args
  )
  if (unavailable) {
    toast.error(unavailableAgentErrorMessage())
    return null
  }
  try {
    const strictStart = await requireWorkItemStartPreflight({
      delivery: promptDelivery,
      agent: prospectiveAgent,
      repoId: args.repoId,
      target: owner.target
    })
    if (
      strictStart &&
      args.launchChoice?.executionHostId &&
      args.launchChoice.executionHostId !== owner.executionHostId
    ) {
      throw new Error('The selected host differs from the Work Item Start preflight host.')
    }
    if (strictStart && args.launchChoice?.requestedSurface === 'terminal') {
      throw new Error('Choose Draft to start this work item in a terminal.')
    }
    return { prospectiveAgent, strictStart }
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.lib.launchWorkItemDirect.workItemStartSupportUnconfirmed',
            'Work Item Start support could not be confirmed.'
          )
    )
    return null
  }
}
