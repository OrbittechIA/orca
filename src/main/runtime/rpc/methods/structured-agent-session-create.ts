import type {
  StructuredAgentSessionLaunchAuthority,
  StructuredAgentSessionLaunchOrigin,
  StructuredAgentSessionResumeSource
} from '../../../../shared/structured-agent-session-create'
import {
  structuredAgentSessionCreateLocationMatchesTarget,
  structuredAgentSessionCreateWorktreeTargetsEqual,
  type StructuredAgentSessionCreateWorktreeTarget
} from '../../structured-agent-session-create-worktree-target'
/**
 * Creating a structured session for a worktree: resolve the create intent, attach it under the
 * host-computed fingerprint, then publish its tab.
 *
 * Extracted from `agentSession.create` so orchestration can start a native-born structured worker
 * on exactly the same path. `activate` is the only knob the two callers differ on: a chat the user
 * asked for takes the surface, a background dispatch must not steal it (the terminal worker path's
 * `surfaceOwner: false`).
 *
 * The prepare/commit split is the pre-commit boundary, not a style choice: nothing before `attach`
 * commits a session, so that span answers with a refusal, and nothing after it may be folded back
 * in. Both callers run the same two halves, so orchestration gets that guarantee too.
 */

import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  resolveUncommittedStructuredCreate,
  type StructuredCreateRefused
} from './structured-agent-session-precommit-refusal'

export type PreparedStructuredAgentSessionCreate = {
  host: StructuredAgentSessionHost
  attachParams: AgentSessionAttachParams
  /** Null when the caller supplied its own location; only a resolved worktree publishes a tab. */
  tab: { workspaceId: string; agent: 'claude' | 'codex' } | null
  /** The workspace lifecycle hold taken at resolution; `commit` releases it after attach. A
   *  caller that never commits must release it itself. */
  releaseWorktreeLifecycle: () => void
  /** The target the scoped authority admitted; re-checked under the hold right before attach. */
  expectedWorktreeTarget: StructuredAgentSessionCreateWorktreeTarget | null
}

/** The pre-commit half. Throws; the caller is expected to run it inside
 *  `resolveUncommittedStructuredCreate` so a failure reaches the client as a refusal. */
export async function prepareStructuredAgentSessionCreateForWorktree(args: {
  runtime: OrcaRuntimeService
  /** Installs the host lazily; called at the same point the RPC handler always installed it. */
  ensureHost: () => Promise<StructuredAgentSessionHost>
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'claude' | 'codex'
  caller: StructuredAgentSessionCaller
  resumeFrom?: StructuredAgentSessionResumeSource
  /** Replaces the seed options the host resolves from settings. Orchestration passes the
   *  `--model`/`--effort` the dispatch asked for; a chat the user opened passes nothing and keeps
   *  the saved selection. Narrowed by the caller, so `{}` never reaches the reservation. */
  options?: Readonly<Record<string, string>>
  /** Marca a admissão estreita no registro; sem isso o gate escopado não reconhece
   *  depois a sessão que ele mesmo acabou de admitir. */
  launchOrigin?: StructuredAgentSessionLaunchOrigin
  launchAuthority?: StructuredAgentSessionLaunchAuthority
  expectedWorktreeTarget?: StructuredAgentSessionCreateWorktreeTarget
}): Promise<PreparedStructuredAgentSessionCreate> {
  // The lifecycle hold spans authoritative resolution → launch preparation → attach, so the
  // record the authority admitted cannot be removed or replaced (removal takes the exclusive
  // side) while the create is in flight. A scoped create knows its workspace before resolving
  // and holds it first; a generic create holds the workspace it resolved.
  const expectedWorktreeTarget = args.expectedWorktreeTarget ?? null
  let releaseWorktreeLifecycle = expectedWorktreeTarget
    ? await args.runtime.holdWorktreeLifecycle(
        expectedWorktreeTarget.worktreeId,
        expectedWorktreeTarget.executionHostId
      )
    : (): void => {}
  try {
    // Adoption replay may need the record loaded from disk before source discovery can be skipped.
    let host = args.resumeFrom ? await args.ensureHost() : null
    // The authoritative comparison lives in the resolver: it sees the worktree RECORD (path,
    // instance, identity, creator), so a workspace replaced under the same id and host between
    // admission and create is refused there. The location check below is the coarse second
    // barrier for a resolver that answers without a record.
    const resolved = await args.runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: args.envelope,
      worktree: args.worktree,
      agent: args.agent,
      callerKey: args.caller.callerKey,
      ...(args.resumeFrom ? { resumeFrom: args.resumeFrom } : {}),
      ...(expectedWorktreeTarget ? { expectedWorktreeTarget } : {})
    })
    if (
      expectedWorktreeTarget &&
      !structuredAgentSessionCreateLocationMatchesTarget(expectedWorktreeTarget, resolved.location)
    ) {
      throw new Error('structured_agent_session_unsupported')
    }
    if (!expectedWorktreeTarget) {
      releaseWorktreeLifecycle = await args.runtime.holdWorktreeLifecycle(
        resolved.location.workspaceId,
        resolved.location.executionHostId
      )
    }
    const resolvedWithOrigin = {
      ...resolved,
      ...(args.launchOrigin ? { launchOrigin: args.launchOrigin } : {}),
      ...(args.launchAuthority ? { launchAuthority: args.launchAuthority } : {})
    }
    const hostFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: args.envelope.sessionId,
      fields: attachFingerprintFields({ ...resolvedWithOrigin, envelope: args.envelope })
    })
    host ??= await args.ensureHost()
    const { agent: _resolvedAgent, provider: _resolvedProvider, ...resolvedAttach } = resolved
    return {
      host,
      attachParams: {
        ...resolvedAttach,
        // After the fingerprint, deliberately: `attachFingerprintFields` excludes options because
        // they are the session's initial state, not its identity, so a retry that re-resolves them
        // must replay rather than conflict.
        ...(args.options ? { options: args.options } : {}),
        provider: resolved.provider as 'claude' | 'codex',
        agent: resolved.agent as 'claude' | 'codex',
        ...(args.launchOrigin ? { launchOrigin: args.launchOrigin } : {}),
        ...(args.launchAuthority ? { launchAuthority: args.launchAuthority } : {}),
        envelope: { ...args.envelope, payloadFingerprint: hostFingerprint }
      },
      tab: {
        workspaceId: resolved.location.workspaceId,
        agent: resolved.agent as 'claude' | 'codex'
      },
      releaseWorktreeLifecycle,
      expectedWorktreeTarget
    }
  } catch (error) {
    releaseWorktreeLifecycle()
    throw error
  }
}

/** The commit half. Past `attach`, a failure no longer proves the session does not exist. */
export async function commitStructuredAgentSessionCreate(args: {
  runtime: OrcaRuntimeService
  caller: StructuredAgentSessionCaller
  prepared: PreparedStructuredAgentSessionCreate
  activate: boolean
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  try {
    // Still under the lifecycle hold, so nothing can replace the record between this check and
    // the attach: the workspace must be the exact one the authority admitted — path, instance,
    // identity, host, creator — or the provider child is never started.
    if (prepared.expectedWorktreeTarget && prepared.tab) {
      const current = await args.runtime.resolveStructuredAgentSessionCreateWorktreeTarget(
        `id:${prepared.tab.workspaceId}`
      )
      if (
        !structuredAgentSessionCreateWorktreeTargetsEqual(prepared.expectedWorktreeTarget, current)
      ) {
        return {
          ok: false,
          refusal: {
            code: 'structured_agent_session_unsupported',
            message: 'The workspace this session was admitted for is no longer the one at its id.'
          }
        }
      }
    }
    return await commitPreparedStructuredAgentSessionCreate(args)
  } finally {
    prepared.releaseWorktreeLifecycle()
  }
}

async function commitPreparedStructuredAgentSessionCreate(args: {
  runtime: OrcaRuntimeService
  caller: StructuredAgentSessionCaller
  prepared: PreparedStructuredAgentSessionCreate
  activate: boolean
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { prepared } = args
  const result = await prepared.host.attach(args.caller, prepared.attachParams)
  if (!result.ok || !prepared.tab) {
    return result
  }
  try {
    await args.runtime.publishStructuredAgentSessionTab({
      workspaceId: prepared.tab.workspaceId,
      sessionId: result.value.sessionId,
      agent: prepared.tab.agent,
      activate: args.activate
    })
  } catch (error) {
    console.warn('[agent-session] create committed before tab publication failed', error)
    return {
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may have been created, but its tab could not be confirmed.'
      }
    }
  }
  return result
}

export async function createStructuredAgentSessionForWorktree(args: {
  runtime: OrcaRuntimeService
  ensureHost: () => Promise<StructuredAgentSessionHost>
  caller: StructuredAgentSessionCaller
  envelope: AgentSessionMutationEnvelope
  worktree: string
  agent: 'claude' | 'codex'
  activate: boolean
  options?: Readonly<Record<string, string>>
}): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const prepared: PreparedStructuredAgentSessionCreate | StructuredCreateRefused =
    await resolveUncommittedStructuredCreate(() =>
      prepareStructuredAgentSessionCreateForWorktree(args)
    )
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  return commitStructuredAgentSessionCreate({
    runtime: args.runtime,
    caller: args.caller,
    prepared,
    activate: args.activate
  })
}
