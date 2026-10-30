import type { RpcContext } from '../core'
import { assertProjectedSessionTabVisible } from './session-tab-browser-placement-projection'
import { projectSessionTabsForContext } from './session-tabs-inventory'

export async function admitSessionTabMutation(
  context: RpcContext,
  worktree: string,
  tabId: string
) {
  const raw = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  const projected = projectSessionTabsForContext(raw, context)
  assertProjectedSessionTabVisible(projected, tabId)
  return { raw, projected }
}
