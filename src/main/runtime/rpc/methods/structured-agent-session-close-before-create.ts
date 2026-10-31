// Main remembers close-before-create because its layout-owning window has no local cancel tombstone; refuse pending creates or close them on arrival.

import type { AgentSessionWireRefusal } from '../../../../shared/agent-session-wire-refusals'
import { refuseUnclassified } from '../../../../shared/agent-session-wire-refusals'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type {
  StructuredAgentSessionLaunchAuthority,
  StructuredAgentSessionLaunchOrigin
} from '../../../../shared/structured-agent-session-create'
import { structuredAgentSessionLaunchAuthoritiesEqual } from '../../../../shared/structured-agent-session-launch-authority'
import type { RpcContext } from '../core'
import {
  canReadStructuredSessionRecord,
  structuredSessionAdmissionRecord,
  structuredSessionLaunchScope,
  structuredWorkItemStartCallerAuthority
} from './structured-agent-session-launch-authority'

type StructuredAgentSessionCreateLaunch = Pick<
  AgentSessionRecord,
  'launchOrigin' | 'launchAuthority'
>

// Per-launch ids prevent cross-create matches; cap entries whose create never arrives.
const MAX_CLOSED_BEFORE_CREATE = 256
// Each close keeps its caller's launch authority, so it fences only creates that caller could close.
const closedBeforeCreate = new Map<string, (StructuredAgentSessionLaunchAuthority | null)[]>()
const createsUnderWay = new Map<string, number>()

/** `hasRecord`: a create already committed, so this is an ordinary close unless one is under way. */
export function noteStructuredAgentSessionClose(
  sessionId: string,
  hasRecord: boolean,
  closer: StructuredAgentSessionLaunchAuthority | null
): void {
  if (hasRecord && !createsUnderWay.has(sessionId)) {
    return
  }
  const closers = closedBeforeCreate.get(sessionId) ?? []
  if (
    !closers.some(
      (noted) =>
        noted === closer ||
        structuredAgentSessionLaunchAuthoritiesEqual(noted ?? undefined, closer ?? undefined)
    )
  ) {
    closers.push(closer)
  }
  closedBeforeCreate.set(sessionId, closers)
  for (const oldest of closedBeforeCreate.keys()) {
    if (closedBeforeCreate.size <= MAX_CLOSED_BEFORE_CREATE) {
      break
    }
    closedBeforeCreate.delete(oldest)
  }
}

export function structuredAgentSessionClosedBeforeCreate(sessionId: string): boolean {
  return closedBeforeCreate.has(sessionId)
}

/** Ordinary creates honor any close; a Work Item Start create honors only its own authority's close. */
export function structuredAgentSessionCreateClosedFirst(
  sessionId: string,
  launch: StructuredAgentSessionCreateLaunch
): boolean {
  const scope = structuredSessionLaunchScope(launch)
  return (
    closedBeforeCreate
      .get(sessionId)
      ?.some(
        (closer) =>
          scope === 'ordinary' ||
          (scope === 'work-item-start' &&
            structuredAgentSessionLaunchAuthoritiesEqual(
              launch.launchAuthority,
              closer ?? undefined
            ))
      ) ?? false
  )
}

export function structuredAgentSessionClosedBeforeCreateRefusal(): AgentSessionWireRefusal {
  return refuseUnclassified(
    'agent_session_operation_invalid',
    'The chat was closed before it was created.'
  )
}

/** Wraps `agentSession.create`: a close that arrived while it ran closes the chat it made. */
export function refusingStructuredAgentSessionCreatesClosedFirst<
  Params extends {
    envelope: { sessionId: string }
    launchOrigin?: StructuredAgentSessionLaunchOrigin
  },
  Result extends { ok: boolean }
>(
  create: (params: Params, ctx: RpcContext) => Promise<Result>
): (
  params: Params,
  ctx: RpcContext
) => Promise<Result | { ok: false; refusal: AgentSessionWireRefusal }> {
  return async (params, ctx) => {
    const { sessionId } = params.envelope
    const authority = params.launchOrigin ? structuredWorkItemStartCallerAuthority(ctx) : null
    const launch: StructuredAgentSessionCreateLaunch = params.launchOrigin
      ? { launchOrigin: params.launchOrigin, ...(authority ? { launchAuthority: authority } : {}) }
      : {}
    createsUnderWay.set(sessionId, (createsUnderWay.get(sessionId) ?? 0) + 1)
    let verdict: CloseBeforeCreateVerdict = 'none'
    try {
      const result = await create(params, ctx)
      verdict = closeBeforeCreateVerdict(ctx, sessionId, launch)
      // The record stays on disk, as for any closed chat; the refusal only says the launch is off.
      return verdict === 'none'
        ? result
        : { ok: false, refusal: structuredAgentSessionClosedBeforeCreateRefusal() }
    } catch (error) {
      verdict = closeBeforeCreateVerdict(ctx, sessionId, launch)
      throw error
    } finally {
      const remaining = (createsUnderWay.get(sessionId) ?? 1) - 1
      if (remaining > 0) {
        createsUnderWay.set(sessionId, remaining)
      } else {
        createsUnderWay.delete(sessionId)
      }
      // Any answer, a refusal or a throw past commit included, may have left the chat made.
      if (verdict === 'close') {
        // Logged, not thrown: the client must still hear that the chat was closed first.
        await closeCreatedChat(ctx, sessionId).catch((error: unknown) =>
          console.warn(
            '[structured-agent-session] closing a chat closed before create failed',
            error
          )
        )
      }
    }
  }
}

type CloseBeforeCreateVerdict = 'none' | 'refuse' | 'close'

/** Before a chat exists the fence matches the requested launch; once one exists, only its persisted owner's admission and launch decide. */
function closeBeforeCreateVerdict(
  ctx: RpcContext,
  sessionId: string,
  launch: StructuredAgentSessionCreateLaunch
): CloseBeforeCreateVerdict {
  const record = structuredSessionAdmissionRecord(getStructuredAgentSessionHost(), sessionId)
  if (!record) {
    return structuredAgentSessionCreateClosedFirst(sessionId, launch) ? 'refuse' : 'none'
  }
  return canReadStructuredSessionRecord(ctx, record) &&
    structuredAgentSessionCreateClosedFirst(sessionId, record)
    ? 'close'
    : 'none'
}

/** The close the window asked for, run now that the chat exists: the tab first, then the agent. */
async function closeCreatedChat(ctx: RpcContext, sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  await host?.setSessionTabVisibility?.(sessionId, false)
  ctx.runtime.retireStructuredAgentSessionTabFromSnapshot(sessionId)
  await host?.close(sessionId, 'user-close')
}

export function resetStructuredAgentSessionClosesBeforeCreateForTests(): void {
  closedBeforeCreate.clear()
  createsUnderWay.clear()
}
