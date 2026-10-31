import { terminalLaunchPublicFacts } from './terminal-launch-result'
import * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-types'

export function revealCreatedTerminal(args: {
  notifier: Pick<RuntimeNotifier, 'revealTerminalSession' | 'rememberLaunchRecipe'> | null
  workspace: Pick<TerminalWorkspaceLaunchScope, 'id' | 'path'>
  ptyId: string
  handle: string
  cwd: string
  launchOpts: dependencies.TerminalCreateOptions
  effectiveLaunchConfig: dependencies.TerminalCreateOptions['launchConfig']
  launchToken: string | undefined
  /** An adopted pane already ran; its recipe and spent launch token must not be re-registered. */
  adoptedStablePane: boolean
  presentation: RuntimeTerminalPresentation | undefined
  opts: dependencies.TerminalCreateOptions
  tabId: string
  leafId: string
}):
  | Pick<dependencies.RuntimeTerminalCreate, 'surface' | 'warning'>
  | Promise<Pick<dependencies.RuntimeTerminalCreate, 'surface' | 'warning'>> {
  const {
    notifier,
    workspace,
    ptyId,
    handle,
    cwd,
    launchOpts,
    effectiveLaunchConfig,
    launchToken,
    adoptedStablePane,
    presentation,
    opts,
    tabId,
    leafId
  } = args
  const reveal = notifier?.revealTerminalSession?.bind(notifier)
  const rememberLaunchRecipe = (): void => {
    if (effectiveLaunchConfig && !adoptedStablePane) {
      notifier?.rememberLaunchRecipe?.({
        tabId,
        leafId,
        launchConfig: effectiveLaunchConfig,
        ...(launchToken ? { launchToken } : {}),
        ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {})
      })
    }
  }
  if (presentation !== 'background' && reveal) {
    return (async () => {
      try {
        await reveal(workspace.id, {
          ptyId,
          title: launchOpts.title ?? null,
          ...(cwd !== workspace.path ? { cwd } : {}),
          ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
          ...(launchToken ? { launchToken } : {}),
          ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
          ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
          activate: presentation === 'focused',
          ...(presentation ? { presentation } : {}),
          ...dependencies.terminalRevealViewerOptions(opts),
          tabId,
          leafId
        })
        return { surface: 'visible' as const }
      } catch (err) {
        console.warn(`[terminal-create] failed to create inactive tab for ${ptyId}:`, err)
        rememberLaunchRecipe()
        return {
          surface: 'background' as const,
          warning: dependencies.createTerminalRevealWarning(handle, err)
        }
      }
    })()
  }
  rememberLaunchRecipe()
  return {
    surface: 'background',
    warning:
      presentation !== 'background' ? dependencies.createTerminalRevealWarning(handle) : undefined
  }
}

export async function finishCreatedTerminal(
  args: Omit<
    Parameters<typeof revealCreatedTerminal>[0],
    'effectiveLaunchConfig' | 'launchToken'
  > & {
    result: Parameters<typeof terminalLaunchPublicFacts>[0]
    pty: Parameters<typeof terminalLaunchPublicFacts>[2]
    paneKey: string
    effectiveTitle: dependencies.TerminalCreateOptions['title'] | null
    effectiveViewMode: dependencies.TerminalCreateOptions['viewMode']
    executionMetadata: () => object
  }
) {
  const reveal = revealCreatedTerminal({
    ...args,
    launchOpts: {
      ...args.launchOpts,
      title: args.pty?.title ?? args.effectiveTitle ?? undefined,
      launchAgent: args.pty?.launchAgent ?? undefined,
      viewMode: args.effectiveViewMode
    },
    effectiveLaunchConfig: args.pty?.launchConfig ?? undefined,
    launchToken: args.pty?.launchToken ?? undefined
  })
  const { surface, warning } = reveal instanceof Promise ? await reveal : reveal
  return {
    ...terminalLaunchPublicFacts(args.result, args.adoptedStablePane, args.pty),
    handle: args.handle,
    savedStartupCwd: args.cwd,
    tabId: args.tabId,
    paneKey: args.paneKey,
    ptyId: args.result.id,
    worktreeId: args.workspace.id,
    title: args.pty?.title ?? args.effectiveTitle ?? null,
    ...args.executionMetadata(),
    surface,
    ...(args.result.startupCwdFallback
      ? { startupCwdFallback: args.result.startupCwdFallback }
      : {}),
    ...(warning ? { warning } : {})
  }
}
