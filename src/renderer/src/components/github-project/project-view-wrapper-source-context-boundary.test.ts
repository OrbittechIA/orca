import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'

function componentSource(name: string): string {
  return readFileSync(resolve(import.meta.dirname, name), 'utf8')
}

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('ProjectViewWrapper GitHub source context boundary', () => {
  it('builds project work items with a host-pinned repository identity', async () => {
    const { buildProjectWorkItem } = await import('./project-work-item')
    const row: GitHubProjectRow = {
      id: 'PVTI_1',
      itemType: 'PULL_REQUEST',
      content: {
        number: 42,
        title: 'Enterprise pull request',
        body: null,
        url: 'https://ghe.example.com/acme/orca/pull/42',
        state: 'OPEN',
        stateReason: null,
        isDraft: false,
        repository: 'acme/orca',
        assignees: [],
        labels: [{ name: 'bug', color: 'd73a4a' }],
        parentIssue: null,
        issueType: null
      },
      fieldValuesByFieldId: {},
      updatedAt: '2026-07-16T00:00:00.000Z',
      position: 0
    }

    expect(buildProjectWorkItem(row, 'repo-1', 'ghe.example.com')).toMatchObject({
      repoId: 'repo-1',
      type: 'pr',
      prRepo: { owner: 'acme', repo: 'orca', host: 'ghe.example.com' }
    })
    expect(buildProjectWorkItem(row, 'repo-1')?.prRepo?.host).toBe('github.com')
  })

  it('passes the matched repo source context into the repo-backed GitHub dialog', () => {
    const actionSource = componentSource('useProjectRowActions.ts')
    const wrapperSource = componentSource('ProjectViewWrapper.tsx')
    const contextSection = sourceBetween(
      actionSource,
      'const dialogRepo = resolvedDialogRepoItem',
      'const missingDialogs'
    )
    const dialogSection = sourceBetween(wrapperSource, '<GitHubItemDialog', 'onUse={(item) => {')

    expect(actionSource).toContain('buildTaskSourceContextFromRepo')
    expect(contextSection).toContain("provider: 'github'")
    expect(contextSection).toContain('repo: dialogRepo')
    expect(dialogSection).toContain('sourceContext={rowActions.dialogSourceContext}')
  })

  it('passes the persisted Start preference from both Project Start and Issue Use', () => {
    const actionSource = componentSource('useProjectRowActions.ts')
    const wrapperSource = componentSource('ProjectViewWrapper.tsx')

    for (const source of [actionSource, wrapperSource]) {
      expect(source).toContain('promptDelivery: resolveWorkItemStartPromptDelivery(')
      expect(source).toContain('settings?.workItemStartPromptDelivery')
    }
  })
})
