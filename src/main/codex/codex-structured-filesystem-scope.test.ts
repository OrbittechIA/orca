import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BoundOrchestrationFilesystemScope } from '../../shared/orchestration-filesystem-scope'
import {
  acquireReadyCodexForTest,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor,
  USER_MESSAGE
} from './codex-structured-session-adapter-fixture'
import {
  codexFilesystemScopeSandboxPolicy,
  codexScopeLaunchViolation,
  codexScopeReplyViolation
} from './codex-structured-filesystem-scope'
import { disposeCodexServerRequest } from './codex-server-request-disposition'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CodexPromptRegistry
} from './codex-structured-prompt-replies'

const writer: BoundOrchestrationFilesystemScope = {
  version: 1,
  kind: 'directory-roots',
  roots: ['/wt/src', '/wt/docs'],
  cwd: '/wt/src',
  worktreePath: '/wt',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  provider: 'codex'
}
const analyst: BoundOrchestrationFilesystemScope = {
  ...writer,
  kind: 'read-only',
  roots: [],
  cwd: '/wt'
}
const writerSandbox = {
  type: 'workspaceWrite',
  writableRoots: ['/wt/src', '/wt/docs'],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true
}

function scopedCodex(sandbox: unknown) {
  const codex = fakeCodex({
    'thread/start': () => ({
      thread: { id: 'thread-abc' },
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox
    })
  })
  let turns = 0
  codex.routes['turn/start'] = (params) => answerWithOpenedTurn(codex, `turn-${++turns}`)(params)
  return codex
}

function finishLatestTurn(codex: ReturnType<typeof fakeCodex>) {
  codex.connections[0].handlers.onNotification?.('turn/completed', {
    threadId: 'thread-abc',
    turn: { id: `turn-${callsFor(codex, 'turn/start').length}`, status: 'completed' }
  })
}

async function acquireScoped(
  codex: ReturnType<typeof fakeCodex>,
  scope: BoundOrchestrationFilesystemScope
) {
  const adapter = adapterFor(codex, { cwd: '/wt', filesystemScope: scope })
  // The user's saved mode is the broadest one; the scope must still win.
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-1',
    permissionMode: 'full-access'
  })
  return adapter
}

const callsFor = (codex: ReturnType<typeof fakeCodex>, method: string) =>
  codex.connections[0].calls.filter((call) => call.method === method)

describe('Codex filesystem scope on the structured provider', () => {
  it('opens a writer thread at its first root with the exact bound policy and keeps it on turns', async () => {
    const codex = scopedCodex(writerSandbox)
    const adapter = await acquireScoped(codex, writer)
    expect(callsFor(codex, 'thread/start')[0]?.params).toMatchObject({
      cwd: '/wt/src',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      config: {
        'sandbox_workspace_write.writable_roots': ['/wt/src', '/wt/docs'],
        'sandbox_workspace_write.network_access': false,
        'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.exclude_slash_tmp': true
      }
    })
    for (const id of ['first', 'second']) {
      await adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: id,
        body: USER_MESSAGE,
        fence: 7
      })
      finishLatestTurn(codex)
    }
    expect(callsFor(codex, 'turn/start')).toHaveLength(2)
    for (const call of callsFor(codex, 'turn/start')) {
      expect(call.params).toMatchObject({
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: writerSandbox
      })
      expect(call.params).not.toHaveProperty('cwd')
    }
  })

  it('opens an analyst thread read-only at the worktree', async () => {
    const codex = scopedCodex({ type: 'readOnly', networkAccess: false })
    const adapter = await acquireScoped(codex, analyst)
    expect(callsFor(codex, 'thread/start')[0]?.params).toMatchObject({
      cwd: '/wt',
      approvalPolicy: 'never',
      sandbox: 'read-only'
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'a',
      body: USER_MESSAGE,
      fence: 7
    })
    expect(callsFor(codex, 'turn/start')[0]?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    })
  })

  it.each([
    ['full access', { type: 'dangerFullAccess' }],
    ['an extra root', { ...writerSandbox, writableRoots: ['/wt/src', '/home'] }],
    ['writable /tmp', { ...writerSandbox, excludeSlashTmp: false }],
    ['network', { ...writerSandbox, networkAccess: true }],
    ['no readback', undefined]
  ])('refuses to use a thread whose reported sandbox grants %s', async (_name, sandbox) => {
    await expect(acquireScoped(scopedCodex(sandbox), writer)).rejects.toThrow(
      /Filesystem scope not applied/
    )
  })

  it('accepts only replies no broader than the binding', () => {
    expect(
      codexScopeReplyViolation(writer, {
        approvalPolicy: 'never',
        sandbox: codexFilesystemScopeSandboxPolicy(writer)
      })
    ).toBeNull()
    expect(
      codexScopeReplyViolation(writer, {
        approvalPolicy: 'never',
        sandbox: { ...writerSandbox, writableRoots: ['/wt/src'] }
      })
    ).toBeNull()
    expect(
      codexScopeReplyViolation(writer, {
        approvalPolicy: 'on-request',
        sandbox: codexFilesystemScopeSandboxPolicy(writer)
      })
    ).toMatch(/approval/)
    expect(
      codexScopeReplyViolation(analyst, { approvalPolicy: 'never', sandbox: writerSandbox })
    ).toMatch(/read-only/)
  })

  it('declines command and file-change approvals for scoped threads instead of prompting', () => {
    for (const method of [CODEX_COMMAND_APPROVAL_METHOD, CODEX_FILE_CHANGE_APPROVAL_METHOD]) {
      const replies: unknown[] = []
      const result = disposeCodexServerRequest(
        new CodexPromptRegistry(),
        { respond: (_id, value) => replies.push(value), respondWithError: () => {} },
        { id: 1, method, params: { threadId: 't', turnId: 'u', itemId: 'i' } },
        true
      )
      expect(result.kind).toBe('responded')
      expect(replies).toEqual([{ decision: 'decline' }])
    }
  })
})

describe('codexScopeLaunchViolation', () => {
  it('refuses a launch after a root is swapped for a symlink or the worktree moves', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'orca-codex-scope-')))
    try {
      const wt = join(base, 'wt')
      await mkdir(join(wt, 'src'), { recursive: true })
      await mkdir(join(base, 'outside'))
      const scope = { ...writer, worktreePath: wt, roots: [join(wt, 'src')], cwd: join(wt, 'src') }
      await expect(codexScopeLaunchViolation(scope, wt)).resolves.toBeNull()
      await expect(codexScopeLaunchViolation(scope, base)).resolves.toMatch(
        /not the scoped worktree/
      )
      await rename(join(wt, 'src'), join(base, 'old-src'))
      await symlink(join(base, 'outside'), join(wt, 'src'))
      await expect(codexScopeLaunchViolation(scope, wt)).resolves.toMatch(/symlink/)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
