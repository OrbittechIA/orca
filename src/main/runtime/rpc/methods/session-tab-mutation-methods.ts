import type { RpcContext } from '../core'
import { projectSessionTabsForContext } from './session-tabs-inventory'
import { restoreStructuredTabsIfSupported } from './structured-session-tab-restore'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod } from '../core'
import {
  assertProjectedSessionTabVisible,
  translateProjectedSessionTabMove
} from './session-tab-browser-placement-projection'
import { ActivateTab, MoveTab, SetTabProps, UpdatePaneLayout } from './session-tabs-schemas'

export const SESSION_TAB_MUTATION_METHODS = [
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, context) => {
      const { runtime, clientKind, pairedDeviceId } = context
      if (clientKind) {
        await restoreStructuredTabsIfSupported(context)
        const visible = projectSessionTabsForContext(
          await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId),
          context
        )
        assertProjectedSessionTabVisible(visible, params.tabId)
      }
      const result = await runtime.activateMobileSessionTab(
        params.worktree,
        params.tabId,
        params.leafId,
        {
          notifyClients: params.notifyClients !== false,
          clientNavigationId: pairedDeviceId,
          ...(params.intent ? { intent: params.intent } : {}),
          navigation: resolveRuntimeNavigationTarget({
            navigation: params.navigation,
            notifyClients: params.notifyClients,
            clientKind
          })
        }
      )
      return projectSessionTabsForContext(result, context)
    }
  }),
  defineMethod({
    name: 'session.tabs.move',
    params: MoveTab,
    handler: async (params, context) => {
      const { runtime, pairedDeviceId, clientKind } = context
      let translated: Parameters<typeof translateProjectedSessionTabMove>[2] = params
      if (clientKind) {
        await restoreStructuredTabsIfSupported(context)
        const raw = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
        const projected = projectSessionTabsForContext(raw, context)
        translated = translateProjectedSessionTabMove(raw, projected, params)
      }
      const base = { tabId: translated.tabId, targetGroupId: translated.targetGroupId }
      if (translated.kind === 'reorder') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'reorder',
          tabOrder: translated.tabOrder
        })
      }
      if (translated.kind === 'split') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'split',
          splitDirection: translated.splitDirection
        })
      }
      return runtime.moveMobileSessionTab(params.worktree, {
        ...base,
        kind: 'move-to-group',
        index: translated.index
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.updatePaneLayout',
    params: UpdatePaneLayout,
    handler: async (params, context) => {
      const { runtime } = context
      await assertVisibleMutationTab(context, params.worktree, params.tabId)
      return runtime.updateMobileSessionPaneLayout(params.worktree, {
        tabId: params.tabId,
        root: params.root,
        expandedLeafId: params.expandedLeafId ?? null,
        titlesByLeafId: params.titlesByLeafId
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.setTabProps',
    params: SetTabProps,
    handler: async (params, context) => {
      const { runtime } = context
      await assertVisibleMutationTab(context, params.worktree, params.tabId)
      return runtime.setMobileSessionTabProps(params.worktree, {
        tabId: params.tabId,
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
        ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
      })
    }
  })
]

async function assertVisibleMutationTab(
  context: RpcContext,
  worktree: string,
  tabId: string
): Promise<void> {
  if (!context.clientKind) {
    return
  }
  // Restaura o escopo durável antes de decidir, e projeta pelo CONTEXTO: decidir
  // sobre um mapa não restaurado recusa uma aba que existe, e projetar só por
  // clientKind autoriza um runtime de outro device.
  await restoreStructuredTabsIfSupported(context)
  const visible = projectSessionTabsForContext(
    await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId),
    context
  )
  assertProjectedSessionTabVisible(visible, tabId)
}
