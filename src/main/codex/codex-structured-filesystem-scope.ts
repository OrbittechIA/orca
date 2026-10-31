import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { BoundOrchestrationFilesystemScope } from '../../shared/orchestration-filesystem-scope'
import type { CodexSandboxPolicy } from './codex-structured-sandbox-policy'

// Codex always lets the thread cwd write under workspaceWrite, so the cwd is a scope root.
// Temp dirs and network are closed; `never` leaves no escalation for a reviewer to grant.
// MCP servers, plugins and apps run outside the sandbox, so a scoped thread may expose none.
const UNSANDBOXED_TOOL_CONFIG = {
  'features.plugins': false,
  'apps._default.enabled': false
} as const

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
    ? { ...base, sandbox: 'read-only', config: { ...UNSANDBOXED_TOOL_CONFIG } }
    : {
        ...base,
        sandbox: 'workspace-write',
        config: {
          ...UNSANDBOXED_TOOL_CONFIG,
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

const mcpStatusPage = z.object({
  data: z.array(
    z.looseObject({
      name: z.string(),
      // Absent status is unknown, not disabled; it must reach the refusal below, not fail parsing.
      runtimeStatus: z.unknown().optional(),
      tools: z.record(z.string(), z.unknown()).optional(),
      resources: z.array(z.unknown()).optional(),
      resourceTemplates: z.array(z.unknown()).optional()
    })
  ),
  nextCursor: z.string().nullish()
})
const configuredMcpServers = z.object({
  config: z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).nullish() })
})

/** Disable each configured server for this thread; an empty table override is not honored. */
export async function codexScopedMcpDisableConfig(
  connection: Pick<CodexAppServerConnection, 'request'>,
  cwd: string,
  timeoutMs: number | null | undefined
): Promise<Record<string, false>> {
  const read = configuredMcpServers.safeParse(
    await connection.request('config/read', { cwd }, { timeoutMs })
  )
  if (!read.success) {
    throw new Error('Filesystem scope not applied: codex did not report its configured MCP servers')
  }
  const { config } = read.data
  const names = Object.keys(config.mcp_servers ?? {})
  const unaddressable = names.filter((name) => !/^[A-Za-z0-9_-]+$/.test(name))
  if (unaddressable.length > 0) {
    throw new Error(
      `Filesystem scope not applied: MCP servers ${unaddressable.join(', ')} cannot be disabled by name`
    )
  }
  return Object.fromEntries(names.map((name) => [`mcp_servers.${name}.enabled`, false]))
}
const installedApps = z.object({
  apps: z.array(z.looseObject({ id: z.string(), callable: z.boolean() }))
})

/** Positive readback from the opened thread; a failed or partial answer refuses rather than assumes. */
export async function codexScopedToolSurfaceViolation(
  connection: Pick<CodexAppServerConnection, 'request'>,
  threadId: string,
  timeoutMs: number | null | undefined
): Promise<string | null> {
  try {
    const servers = mcpStatusPage.parse(
      await connection.request(
        'mcpServerStatus/list',
        { threadId, detail: 'toolsAndAuthOnly' },
        { timeoutMs }
      )
    )
    // Only positively disabled, empty entries are inert; failed or unknown status proves nothing.
    const live = servers.data.filter(
      (server) =>
        server.runtimeStatus !== 'disabled' ||
        Object.keys(server.tools ?? {}).length > 0 ||
        (server.resources?.length ?? 0) > 0 ||
        (server.resourceTemplates?.length ?? 0) > 0
    )
    if (live.length > 0 || servers.nextCursor) {
      const names = live.map((server) => server.name).join(', ')
      return `the thread exposes MCP servers that run outside the sandbox: ${names || 'more pages'}`
    }
    const apps = installedApps.parse(
      await connection.request('app/installed', { threadId }, { timeoutMs })
    )
    const callable = apps.apps.filter((app) => app.callable).map((app) => app.id)
    if (callable.length > 0) {
      return `the thread exposes app connectors that run outside the sandbox: ${callable.join(', ')}`
    }
    return null
  } catch (error) {
    return `codex could not prove the thread has no unsandboxed tools (${error instanceof Error ? error.message : String(error)})`
  }
}
