import { toast } from 'sonner'
import {
  structuredWorkItemLaunchUnavailableMessage,
  structuredWorkItemPromptDeliveryFailedMessage
} from '@/lib/launch-work-item-direct-messages'
import type { LaunchWorkItemDirectArgs } from '@/lib/launch-work-item-direct-types'
import type { Repo } from '../../../shared/repo-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { StructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import { workItemStartStrictPreflightBlocks } from '@/lib/work-item-start-precreate-preflight'

// The strict (`submit-after-ready`) half of a direct Work Item Start: it refuses before the
// worktree exists, never falls back to a terminal writer, and reports started only on proof.

/** Strict by default for `submit-after-ready`; only an explicit opt-in lets a terminal take it. */
export function isStrictDirectWorkItemStart(
  promptDelivery: 'draft' | 'submit-after-ready',
  args: Pick<LaunchWorkItemDirectArgs, 'allowLegacyTerminalPromptSubmission'>
): boolean {
  return (
    promptDelivery === 'submit-after-ready' && args.allowLegacyTerminalPromptSubmission !== true
  )
}

/** Decided BEFORE `git worktree add`: a later refusal would leave a workspace with no writer. */
export async function refuseStrictDirectWorkItemBeforeCreate(
  args: Pick<LaunchWorkItemDirectArgs, 'agentOverride' | 'repoId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  // `settings` is the launch's snapshot, not a re-read after the awaits.
  inputs: {
    draftContent: string
    detectedAgentsPromise: Promise<string[]> | null
    settings: GlobalSettings | null | undefined
  }
): Promise<boolean> {
  const blocked = await workItemStartStrictPreflightBlocks({
    ...inputs,
    agentOverride: args.agentOverride,
    repo,
    repoConnectionId: repo.connectionId?.trim() || null,
    repoId: args.repoId
  })
  if (blocked) {
    toast.error(structuredWorkItemLaunchUnavailableMessage())
  }
  return blocked
}

/** The launch a strict Start continues on; `undefined` stops it with no terminal in its place. */
export function claimStrictDirectWorkItemLaunch(
  routeLost: boolean,
  launch: StructuredAgentSessionProvisionalLaunch | undefined
): StructuredAgentSessionProvisionalLaunch | undefined {
  if (routeLost) {
    toast.error(structuredWorkItemLaunchUnavailableMessage())
    return undefined
  }
  return launch
}

/**
 * Strict delivery is proof, not intent: a strict Start only reports started once the host
 * confirmed the prompt. Without a prompt there is nothing to deliver, so it holds vacuously.
 */
export async function settleStrictDirectWorkItemDelivery(args: {
  launch: StructuredAgentSessionProvisionalLaunch
  hasPrompt: boolean
}): Promise<boolean> {
  let settlement: Awaited<StructuredAgentSessionProvisionalLaunch['settlement']>
  try {
    settlement = await args.launch.settlement
  } catch {
    return false
  }
  // Why: failed, cancelled and unknown launches are surfaced by the launch layer and its chat tab.
  if (settlement.kind !== 'structured') {
    return false
  }
  if (!args.hasPrompt) {
    return true
  }
  const delivery = await settlement.promptDeliveryResult
  if (delivery?.delivered === true) {
    return true
  }
  if (delivery?.failureNotified !== true && delivery?.deliveryUnknown !== true) {
    toast.error(structuredWorkItemPromptDeliveryFailedMessage())
  }
  return false
}
