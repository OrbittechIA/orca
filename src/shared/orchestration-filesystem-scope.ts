import { z } from 'zod'

export const ORCHESTRATION_FILESYSTEM_SCOPE_VERSION = 1 as const
export const ORCHESTRATION_FILESYSTEM_SCOPE_MAX_ROOTS = 32
const MAX_ROOT_LENGTH = 1024
const MAX_PATH_LENGTH = 4096
const MAX_ID_LENGTH = 512

/** Writes are scoped; reads stay unrestricted because the Codex candidate rejects restricted-read fields. */
export type OrchestrationFilesystemScopeRequest =
  | { version: typeof ORCHESTRATION_FILESYSTEM_SCOPE_VERSION; kind: 'read-only' }
  | {
      version: typeof ORCHESTRATION_FILESYSTEM_SCOPE_VERSION
      kind: 'directory-roots'
      /** Worktree-relative directories; the first is the provider thread's cwd. */
      roots: string[]
    }

/** Lexical half of root admission; symlinks and existence are checked against the worktree at bind time. */
export function filesystemScopeRootError(root: string): string | null {
  if (root.length === 0 || root.length > MAX_ROOT_LENGTH) {
    return 'must be a non-empty worktree-relative directory'
  }
  if (root.includes('\0')) {
    return 'must not contain NUL'
  }
  if (root.startsWith('/') || root.startsWith('\\') || /^[A-Za-z]:/.test(root)) {
    return 'must be relative to the worktree'
  }
  // Only whole directories are enforceable; a pattern must not widen to its containing directory.
  if (/[*?[\]{}]/.test(root)) {
    return 'must be a directory, not a glob pattern'
  }
  const segments = root.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) {
    return 'must not traverse with ..'
  }
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return 'must not name Git metadata'
  }
  return null
}

/** Normalize to forward-slash segments; '.' means the worktree root. */
export function normalizeFilesystemScopeRoot(root: string): string {
  const segments = root.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.')
  return segments.length === 0 ? '.' : segments.join('/')
}

function rootContains(parent: string, child: string): boolean {
  return parent === '.' || child === parent || child.startsWith(`${parent}/`)
}

export const OrchestrationFilesystemScopeRequestSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      version: z.literal(ORCHESTRATION_FILESYSTEM_SCOPE_VERSION),
      kind: z.literal('read-only')
    }),
    z.strictObject({
      version: z.literal(ORCHESTRATION_FILESYSTEM_SCOPE_VERSION),
      kind: z.literal('directory-roots'),
      roots: z.array(z.string()).min(1).max(ORCHESTRATION_FILESYSTEM_SCOPE_MAX_ROOTS)
    })
  ])
  .superRefine((scope, ctx) => {
    if (scope.kind !== 'directory-roots') {
      return
    }
    const normalized: string[] = []
    scope.roots.forEach((root, index) => {
      const error = filesystemScopeRootError(root)
      if (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roots', index],
          message: `Scope root ${JSON.stringify(root)} ${error}`
        })
        return
      }
      normalized.push(normalizeFilesystemScopeRoot(root))
    })
    // Overlapping roots would make the advertised write set ambiguous.
    for (const [index, root] of normalized.entries()) {
      const overlap = normalized.find((other, j) => j !== index && rootContains(other, root))
      if (overlap !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roots'],
          message: `Scope roots ${JSON.stringify(overlap)} and ${JSON.stringify(root)} overlap`
        })
        return
      }
    }
  })

/** The policy as bound to one Task, Dispatch, worktree and provider; never rewritten after founding. */
export type BoundOrchestrationFilesystemScope = {
  version: typeof ORCHESTRATION_FILESYSTEM_SCOPE_VERSION
  kind: 'read-only' | 'directory-roots'
  /** Absolute, symlink-free directories; empty for read-only. */
  roots: string[]
  /** Provider thread cwd: the worktree for read-only, roots[0] for directory-roots. */
  cwd: string
  worktreePath: string
  taskId: string
  dispatchId: string
  provider: 'codex'
}

const AbsoluteHostPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => value.startsWith('/') && !value.includes('\0'))
const BoundedId = z.string().min(1).max(MAX_ID_LENGTH)

function pathWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

const BoundOrchestrationFilesystemScopeSchema = z
  .strictObject({
    version: z.literal(ORCHESTRATION_FILESYSTEM_SCOPE_VERSION),
    kind: z.enum(['read-only', 'directory-roots']),
    roots: z.array(AbsoluteHostPath).max(ORCHESTRATION_FILESYSTEM_SCOPE_MAX_ROOTS),
    cwd: AbsoluteHostPath,
    worktreePath: AbsoluteHostPath,
    taskId: BoundedId,
    dispatchId: BoundedId,
    provider: z.literal('codex')
  })
  .refine((scope) =>
    scope.kind === 'read-only'
      ? scope.roots.length === 0 && scope.cwd === scope.worktreePath
      : scope.roots.length > 0 &&
        scope.cwd === scope.roots[0] &&
        scope.roots.every((root) => pathWithin(scope.worktreePath, root))
  )

export function isBoundOrchestrationFilesystemScope(
  value: unknown
): value is BoundOrchestrationFilesystemScope {
  return BoundOrchestrationFilesystemScopeSchema.safeParse(value).success
}

export function boundOrchestrationFilesystemScopesEqual(
  left: BoundOrchestrationFilesystemScope | undefined,
  right: BoundOrchestrationFilesystemScope | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.cwd === right.cwd &&
    left.worktreePath === right.worktreePath &&
    left.taskId === right.taskId &&
    left.dispatchId === right.dispatchId &&
    left.provider === right.provider &&
    left.roots.length === right.roots.length &&
    left.roots.every((root, index) => root === right.roots[index])
  )
}
