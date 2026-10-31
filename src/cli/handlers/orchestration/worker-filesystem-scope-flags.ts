import { getOptionalStringFlag, getRepeatedStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import {
  ORCHESTRATION_FILESYSTEM_SCOPE_VERSION,
  OrchestrationFilesystemScopeRequestSchema,
  type OrchestrationFilesystemScopeRequest
} from '../../../shared/orchestration-filesystem-scope'

/** `--scope read-only` or `--scope write-roots --scope-root <dir>...`; absent keeps today's launch. */
export function readWorkerFilesystemScopeFlags(
  flags: Map<string, string | boolean>
): OrchestrationFilesystemScopeRequest | undefined {
  const scope = getOptionalStringFlag(flags, 'scope')
  const roots = getRepeatedStringFlag(flags, 'scope-root')
  if (scope === undefined) {
    if (roots.length > 0) {
      throw new RuntimeClientError('invalid_argument', '--scope-root requires --scope write-roots')
    }
    return undefined
  }
  if (scope === 'read-only' && roots.length > 0) {
    throw new RuntimeClientError('invalid_argument', '--scope read-only takes no --scope-root')
  }
  if (scope !== 'read-only' && scope !== 'write-roots') {
    throw new RuntimeClientError('invalid_argument', '--scope must be read-only or write-roots')
  }
  const parsed = OrchestrationFilesystemScopeRequestSchema.safeParse(
    scope === 'read-only'
      ? { version: ORCHESTRATION_FILESYSTEM_SCOPE_VERSION, kind: 'read-only' }
      : { version: ORCHESTRATION_FILESYSTEM_SCOPE_VERSION, kind: 'directory-roots', roots }
  )
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_argument',
      parsed.error.issues.map((issue) => issue.message).join('; ')
    )
  }
  return parsed.data
}
