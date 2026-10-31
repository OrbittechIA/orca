import { realpath } from 'node:fs/promises'
import type { BoundOrchestrationFilesystemScope } from '../../shared/orchestration-filesystem-scope'
import type { CodexSandboxPolicy } from './codex-structured-sandbox-policy'

// Codex always lets the thread cwd write under workspaceWrite, so the cwd is a scope root.
// Temp dirs and network are closed; `never` leaves no escalation for a reviewer to grant.

export function codexFilesystemScopeSandboxPolicy(
  scope: BoundOrchestrationFilesystemScope
): CodexSandboxPolicy {
  return scope.kind === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : {
        type: 'workspaceWrite',
        writableRoots: [...scope.roots],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
}

/** thread/start and thread/resume take a sandbox mode plus config, not a full policy. */
export function codexFilesystemScopeThreadSettings(scope: BoundOrchestrationFilesystemScope): {
  cwd: string
  approvalPolicy: 'never'
  approvalsReviewer: 'user'
  sandbox: 'read-only' | 'workspace-write'
  config: Record<string, unknown>
} {
  const base = { cwd: scope.cwd, approvalPolicy: 'never', approvalsReviewer: 'user' } as const
  return scope.kind === 'read-only'
    ? { ...base, sandbox: 'read-only', config: {} }
    : {
        ...base,
        sandbox: 'workspace-write',
        config: {
          'sandbox_workspace_write.writable_roots': [...scope.roots],
          'sandbox_workspace_write.network_access': false,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true,
          'sandbox_workspace_write.exclude_slash_tmp': true
        }
      }
}

export type CodexTurnScopePermission = {
  approvalPolicy: 'never'
  approvalsReviewer: 'user'
  sandboxPolicy: CodexSandboxPolicy
}

export function codexFilesystemScopeTurnPermission(
  scope: BoundOrchestrationFilesystemScope
): CodexTurnScopePermission {
  return {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxPolicy: codexFilesystemScopeSandboxPolicy(scope)
  }
}

/** The provider's own readback must be no broader than the bound policy, or the thread is not used. */
export function codexScopeReplyViolation(
  scope: BoundOrchestrationFilesystemScope,
  reply: { approvalPolicy?: unknown; sandbox?: CodexSandboxPolicy }
): string | null {
  if (reply.approvalPolicy !== 'never') {
    return `codex reported approval policy ${JSON.stringify(reply.approvalPolicy)}, not never`
  }
  const sandbox = reply.sandbox
  if (!sandbox) {
    return 'codex did not report the sandbox it applied'
  }
  if (scope.kind === 'read-only') {
    return sandbox.type === 'readOnly' && sandbox.networkAccess !== true
      ? null
      : `codex reported sandbox ${sandbox.type} for a read-only scope`
  }
  if (sandbox.type === 'readOnly' && sandbox.networkAccess !== true) {
    return null
  }
  if (sandbox.type !== 'workspaceWrite') {
    return `codex reported sandbox ${sandbox.type} for a directory-roots scope`
  }
  const extra = sandbox.writableRoots.filter((root) => !scope.roots.includes(root))
  if (extra.length > 0) {
    return `codex reported writable roots outside the scope: ${extra.join(', ')}`
  }
  if (sandbox.networkAccess || !sandbox.excludeTmpdirEnvVar || !sandbox.excludeSlashTmp) {
    return 'codex reported network or temporary-directory write access outside the scope'
  }
  return null
}

/** Re-check at every launch: a root replaced by a symlink since founding would redirect writes. */
export async function codexScopeLaunchViolation(
  scope: BoundOrchestrationFilesystemScope,
  launchDirectory: string
): Promise<string | null> {
  const resolved = await realpath(launchDirectory).catch(() => null)
  if (resolved !== scope.worktreePath) {
    return `launch directory ${launchDirectory} is not the scoped worktree ${scope.worktreePath}`
  }
  for (const root of [scope.cwd, ...scope.roots]) {
    if ((await realpath(root).catch(() => null)) !== root) {
      return `scope directory ${root} is missing or now resolves through a symlink`
    }
  }
  return null
}
