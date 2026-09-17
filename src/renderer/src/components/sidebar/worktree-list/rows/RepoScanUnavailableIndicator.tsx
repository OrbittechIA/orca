import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  classifyWorktreeScanFailure,
  type WorktreeScanFailure
} from '../../../../../../shared/worktree-scan-failure'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle
} from './header-event-guards'

/**
 * Marks a repo whose worktree scan failed, so its rows are retained but cannot be trusted.
 * Click re-runs the scan: the failure is otherwise re-tried only by the next incidental refresh.
 */
export function RepoScanUnavailableIndicator({ repo }: { repo: Repo }): React.JSX.Element | null {
  const detected = useAppStore((s) => s.detectedWorktreesByRepo[repo.id])
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [pending, setPending] = React.useState(false)
  if (!detected || detected.authoritative || !detected.unavailableReason) {
    return null
  }
  const title = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.title',
    'Worktree scan failed for {{value0}}',
    { value0: repo.displayName }
  )
  const retryLabel = translate(
    'auto.components.sidebar.RepoScanUnavailableIndicator.retry',
    'Retry scan'
  )
  const isLocalHost = getRepoExecutionHostId(repo) === 'local' && !repo.connectionId
  const failure: WorktreeScanFailure = isLocalHost
    ? classifyWorktreeScanFailure(detected.unavailableReason)
    : { kind: 'unknown', message: detected.unavailableReason }
  const fixCommand = isLocalHost ? failure.fixCommand : undefined
  const diagnosticText = [
    `Repository: ${repo.displayName}`,
    ...(isLocalHost
      ? [`Path: ${repo.path}`, `Platform: ${navigator.platform}`]
      : ['Execution host: remote']),
    `Failure: ${detected.unavailableReason}`
  ].join('\n')
  const copyText = async (value: string): Promise<void> => {
    await navigator.clipboard?.writeText(value)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-repo-header-action=""
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-destructive',
            pending && 'opacity-60'
          )}
          aria-label={`${title}. ${retryLabel}`}
          aria-busy={pending}
          disabled={pending}
          onKeyDown={stopRepoHeaderKeyboardToggle}
          onPointerDown={handleRepoHeaderActionPointerDown}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setPending(true)
            void fetchWorktrees(repo.id, {
              executionHostId: getRepoExecutionHostId(repo)
            }).finally(() => setPending(false))
          }}
        >
          <TriangleAlert className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72">
        <div className="space-y-1">
          <div className="font-medium">{title}</div>
          <div className="break-words text-muted-foreground">{failure.message}</div>
          {fixCommand ? (
            <div>
              <div className="break-words font-mono text-xs text-muted-foreground">
                {fixCommand}
              </div>
            </div>
          ) : null}
          <div className="text-muted-foreground">
            {translate(
              'auto.components.sidebar.RepoScanUnavailableIndicator.retained',
              'Existing worktrees are kept until a scan succeeds. Click to retry.'
            )}
          </div>
          <div className="flex items-center justify-start gap-3 border-t border-border/60 pt-1">
            {fixCommand ? (
              <button
                type="button"
                className="text-xs underline"
                onClick={() => void copyText(fixCommand)}
              >
                Copy command
              </button>
            ) : null}
            <button
              type="button"
              className="text-xs underline"
              onClick={() => void copyText(diagnosticText)}
            >
              Copy diagnostics
            </button>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
