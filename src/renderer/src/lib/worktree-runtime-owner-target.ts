import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export class AmbiguousStructuredSessionOwnerError extends Error {
  constructor(worktreeId: string) {
    super(`More than one runtime claims ${worktreeId}; Orca did not guess which one owns it.`)
  }
}

/**
 * O runtime que detém esta worktree — o mesmo que a criou.
 *
 * `getActiveRuntimeTarget` responde pelo foco global e `createWorktree` roteia pelo dono do
 * repo. Quando um repo explícito pertence a outro ambiente as duas divergem, e a sessão
 * nasceria num runtime onde a workspace não existe.
 *
 * Owner ambíguo NÃO vira local: escolher um dono no palpite abriria um segundo writer, que
 * é exatamente o dano que este caminho existe para evitar. `missing` é diferente — logo
 * após o create a linha ainda não aterrissou —, e aí vale o mesmo dono de repo por onde o
 * `createWorktree` roteou.
 */
export function runtimeTargetForWorktreeOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): RuntimeClientTarget {
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'ambiguous') {
    throw new AmbiguousStructuredSessionOwnerError(worktreeId)
  }
  if (resolution.kind === 'resolved') {
    const environmentId = resolution.route.runtimeEnvironmentId?.trim()
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  }
  return getActiveRuntimeTarget(
    getSettingsForRepoRuntimeOwner(state, getRepoIdFromWorktreeId(worktreeId))
  )
}
