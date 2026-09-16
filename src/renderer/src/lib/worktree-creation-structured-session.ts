import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import type { StructuredAgentLaunchRecovery } from '@/lib/structured-agent-session-launch-callers'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  visibilityUnknown?: boolean
  /** Strict delivery without confirmation: reconcile the SAME message, never send another. */
  promptDeliveryUnknown?: boolean
  /** `prompt-delivery`: definitive delivery refusal — the workspace stays, the retry does not.
   *  `structured-refused`: the host refused the strict create — the workspace stays with no writer
   *  and no terminal opens in its place; the retry may try the session again.
   *  `structured-launch`: the strict launch never reached a session (a throw before the create,
   *  or a generic `failed` settlement) — same discipline: no writer, no terminal, no completion. */
  failure?: 'prompt-delivery' | 'structured-refused' | 'structured-launch'
  /** The exact intent and staged prompt of the launch, for a retry after an unknown outcome. */
  recovery?: StructuredAgentLaunchRecovery
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

type LaunchStructuredWorktreeSessionArgs = {
  creationId: string
  request: WorktreeCreationRequest
  /** Required: a non-structured route opens no session here, so the caller must have gated on it. */
  agentLaunchRoute: AgentLaunchRoute
  worktreeId: string
  shouldActivateOnCompletion: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  /** Re-enter the launch this creation already made, with its persisted intent and prompt. */
  recover?: StructuredAgentLaunchRecovery
}

export async function launchStructuredWorktreeSession(
  args: LaunchStructuredWorktreeSessionArgs
): Promise<WorktreeCreationStructuredSessionResult> {
  let { activation, primaryTabId } = args
  const settled = { accepted: true, cancelled: false }
  const { agent } = args.request
  if (!isAgentSessionHandleProvider(agent)) {
    return { ...settled, activation, primaryTabId }
  }
  const isCancelled = (): boolean =>
    !useAppStore.getState().pendingWorktreeCreations[args.creationId]
  if (isCancelled()) {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  // Strict Work Item Start: the preflight admitted the SCOPED create (`launchOrigin`), which an
  // older host, or a host with global structured chat off, only admits under that origin.
  const strict = args.request.workItemStartPromptDelivery === 'submit-after-ready'
  // Why: the composer decided route and delivery mode before the worktree existed, and the request
  // carries that verdict in renderer memory for the life of the create; re-entering with it is what
  // keeps a retry from re-resolving against a host that has changed since. A retry re-enters with
  // the same prompt AND the persisted intent: the launch layer finds the staged operation instead
  // of staging another.
  const plan = adoptAgentSessionLaunchVerdict({
    route: args.agentLaunchRoute,
    agent,
    ...(strict ? { launchOrigin: 'work-item-start' as const } : {}),
    prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt,
    ...(args.request.promptDelivery ? { promptDelivery: args.request.promptDelivery } : {}),
    ...(args.recover ? { recover: args.recover } : {})
  })
  const abandoned = new AbortController()
  let ownershipTransferred = false
  let launch: ReturnType<typeof beginStructuredAgentSessionProvisionalLaunch> = null
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!ownershipTransferred && !state.pendingWorktreeCreations[args.creationId]) {
      abandoned.abort()
    }
  })
  try {
    launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: abandoned.signal },
      target: { worktreeId: args.worktreeId },
      activate: args.shouldActivateOnCompletion,
      beforeOpen: () => {
        // Why: cancellation can arrive through the launch signal while reveal is running, before
        // the pending-creation store snapshot has caught up.
        if (abandoned.signal.aborted || isCancelled()) {
          return false
        }
        if (args.shouldActivateOnCompletion && !activation) {
          try {
            activation = activateAndRevealWorktree(args.worktreeId, {
              providesInitialSurface: true
            })
          } catch (error) {
            // Why: without a revealed workspace the provisional tab has no visible owner.
            console.error('worktree create: structured chat reveal failed', args.worktreeId, error)
            activation = false
            return false
          }
          if (activation === false) {
            return false
          }
          primaryTabId = activation.primaryTabId
        }
        return !abandoned.signal.aborted && !isCancelled()
      }
    })
    ownershipTransferred = launch !== null
    if (launch) {
      primaryTabId = launch.tab.id
    }
  } catch {
    // Why: nothing awaits this creation's caller, so an escaped throw would strand the panel
    // mid-create. Report it the way a failed launch already does; the launch layer toasts it.
    // Strict: a launch that threw (an ambiguous runtime owner, a failed intent) started no
    // session and delivered no prompt, and "accepted" would complete the creation on nothing.
    return strict ? structuredLaunchFailed() : { ...settled, activation, primaryTabId }
  } finally {
    unsubscribe()
  }
  if (!strict) {
    return { ...settled, activation, primaryTabId }
  }
  if (!launch) {
    // Why: a strict launch that opened no surface only completes as a cancel, never as a Start.
    return abandoned.signal.aborted || isCancelled()
      ? { ...settled, cancelled: true, activation, primaryTabId }
      : structuredLaunchFailed()
  }
  // Strict delivery is proof: without confirmation the create does not complete, and uncertainty
  // (reconcilable) is never treated as a refusal (definitive).
  const settlement = await launch.settlement
  if (settlement.kind === 'cancelled') {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  if (settlement.kind === 'visibility-unknown') {
    const { recovery } = settlement
    return { ...settled, visibilityUnknown: true, recovery, activation, primaryTabId }
  }
  if (settlement.kind === 'failed') {
    // A strict create the host refused settles here: the workspace exists with no writer, and that
    // is reported, never papered over.
    if (settlement.error instanceof StructuredAgentSessionCreateRefusalError) {
      return {
        ...settled,
        accepted: false,
        failure: 'structured-refused',
        activation,
        primaryTabId
      }
    }
    // Any other strict failure is the same discipline under another name: no session, no proof,
    // no completion.
    return structuredLaunchFailed()
  }
  const { recovery } = settlement
  const delivery = await settlement.promptDeliveryResult
  if (delivery?.delivered) {
    return { ...settled, recovery, activation, primaryTabId }
  }
  // No delivery evidence at all is not evidence of delivery. A strict Start only completes on
  // proof; silence is reconciled later under the same intent, never completed or replaced.
  if (!delivery || delivery.deliveryUnknown === true) {
    return { ...settled, promptDeliveryUnknown: true, recovery, activation, primaryTabId }
  }
  return { ...settled, failure: 'prompt-delivery' as const, recovery, activation, primaryTabId }

  function structuredLaunchFailed(): WorktreeCreationStructuredSessionResult {
    return { ...settled, accepted: false, failure: 'structured-launch', activation, primaryTabId }
  }
}
