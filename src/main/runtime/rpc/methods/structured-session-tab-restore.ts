import type { RpcContext } from '../core'
import {
  isStructuredNativeChatEnabled,
  structuredWorkItemStartCallerAuthority,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'
import { restoreWorkItemStartStructuredAgentSessionTabs } from '../../work-item-start-structured-tab-restore'
import { canAccessWorkItemStartStructuredSession } from './structured-agent-session-gate'

/** Republishes structured tabs into the host's own snapshot map.
 *
 *  Mobile is gated on the host setting alone, NOT on the client's capability: an old build is
 *  shown a fallback prompt in place of each chat, and gating on capability left it with nothing to
 *  project after a desktop restart — no chat and no prompt. The setting still gates it, because
 *  with structured chat off there is nothing for any mobile client to reach. Restoring spawns no
 *  provider child for a cleanly closed session.
 *
 *  With the setting off, a Start-authorized runtime restores Work Item Start tabs only; ordinary
 *  structured tabs stay down, and the projection still shows each Start tab to its owner alone. */
export async function restoreStructuredTabsIfSupported(
  context: Pick<
    RpcContext,
    'runtime' | 'clientKind' | 'clientCapabilities' | 'localDesktopAuthority' | 'pairedDeviceId'
  >
): Promise<void> {
  const shouldRestore =
    context.clientKind === 'mobile'
      ? isStructuredNativeChatEnabled(context.runtime)
      : supportsStructuredAgentSessions(context)
  if (shouldRestore) {
    if (typeof context.runtime.restoreStructuredAgentSessionTabs === 'function') {
      await context.runtime.restoreStructuredAgentSessionTabs()
    }
    return
  }
  if (context.clientKind !== 'mobile' && structuredWorkItemStartCallerAuthority(context)) {
    await restoreWorkItemStartStructuredAgentSessionTabs(context.runtime, (sessionId) =>
      canAccessWorkItemStartStructuredSession(context, sessionId)
    )
  }
}
