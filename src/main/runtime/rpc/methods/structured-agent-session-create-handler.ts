import type { StructuredAgentSessionLaunchAuthority } from '../../../../shared/structured-agent-session-create'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import type { z } from 'zod'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { agentSessionFingerprintConflict } from '../../../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import type { StructuredAgentSessionCreateWorktreeTarget } from '../../structured-agent-session-create-worktree-target'
import type { RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredHost as requireHost,
  requireStructuredAgentAudience,
  requireStructuredSessionAdmission,
  structuredWorkItemStartCallerAuthority,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { AttachParams, CreateParams } from './structured-agent-session-schemas'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  structuredAgentSessionClosedBeforeCreate,
  structuredAgentSessionClosedBeforeCreateRefusal
} from './structured-agent-session-close-before-create'

/** Attach-shaped requests bypass workspace create-support; ask the execution host directly so client-supplied locations cannot forge support. */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureHostInstalled(ctx, params.agent)
  const host = requireHost(ctx, params.agent)
  requireStructuredSessionAdmission(ctx, host, params.envelope.sessionId)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  // Reservation applies options only to a record it creates, so an existing chat is never reseeded.
  const permissionMode = ctx.runtime.structuredAgentSessionLaunchSeedOptions(params.agent)?.[
    AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  ]
  const attachParams: AgentSessionAttachParams = {
    ...params,
    ...(permissionMode
      ? { options: { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode } }
      : {})
  }
  return { host, attachParams }
}

export async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}

export async function handleStructuredAgentSessionCreate(
  params: z.infer<typeof CreateParams>,
  ctx: RpcContext
) {
  requireStructuredAgentAudience(ctx, params.agent)
  if (params.envelope.expectedRuntimeFence !== null) {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'requestMalformed'
    })
  }
  // Before attach, return refusals instead of throwing so clients can distinguish no effects from unknown outcomes.
  const prepared = await resolveUncommittedStructuredCreate(async () => {
    if ('worktree' in params) {
      const conflict = agentSessionFingerprintConflict(
        params.envelope,
        structuredAgentSessionCreateIntentFingerprint(params)
      )
      if (conflict) {
        return { refusal: conflict }
      }
      if (params.launchOrigin && params.resumeFrom) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostUnsupported' })
      }
      let expectedWorktreeTarget: StructuredAgentSessionCreateWorktreeTarget | undefined
      let launchAuthority: StructuredAgentSessionLaunchAuthority | null = null
      if (params.launchOrigin) {
        launchAuthority = structuredWorkItemStartCallerAuthority(ctx)
        if (!launchAuthority) throw agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'clientCapabilityMissing' })
        const target = await ctx.runtime.resolveStructuredAgentSessionCreateWorktreeTarget(params.worktree)
        expectedWorktreeTarget = target
        if (launchAuthority.kind === 'paired-device' && target.creatorDeviceId !== launchAuthority.deviceId) {
          throw agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'clientCapabilityMissing' })
        }
      }
      // Read persisted ownership before resolving accounts, adoption or launch effects.
      await ensureHostInstalled(ctx)
      const existingHost = requireHost(ctx)
      requireStructuredSessionAdmission(ctx, existingHost, params.envelope.sessionId)
      return prepareStructuredAgentSessionCreateForWorktree({
        runtime: ctx.runtime,
        ensureHost: async () => {
          await ensureHostInstalled(ctx)
          return requireHost(ctx)
        },
        envelope: params.envelope,
        worktree: params.worktree,
        agent: params.agent,
        caller: callerFor(ctx),
        ...(launchAuthority ? { launchAuthority } : {}),
        ...(expectedWorktreeTarget ? { expectedWorktreeTarget } : {}),
        structuredAgentCliSourceEvidence: ctx.structuredAgentCliSourceEvidence,
        ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
        ...(params.launchOrigin ? { launchOrigin: params.launchOrigin } : {}),
        ...(params.tabId ? { tabId: params.tabId } : {}),
        ...(params.optionsMode ? { optionsMode: params.optionsMode } : {}),
        ...(params.options ? { options: params.options } : {}),
        ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
        atRest: Boolean(
          params.firstMessage ||
          ctx.clientCapabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
        )
      })
    }
    const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
    return { host, attachParams, tab: null }
  })
  if ('refusal' in prepared) {
    return { ok: false, refusal: prepared.refusal }
  }
  // Nothing is created yet, so a close that came first refuses the create outright.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    structuredAgentSessionClosedBeforeCreate(params.envelope.sessionId)
  ) {
    return { ok: false, refusal: structuredAgentSessionClosedBeforeCreateRefusal() }
  }
  return commitStructuredAgentSessionCreate({
    runtime: ctx.runtime,
    caller: callerFor(ctx),
    prepared,
    activate: true,
    placedByWindow: ctx.caller?.kind === 'desktop',
    ...('tabPlacement' in params && params.tabPlacement
      ? { tabPlacement: params.tabPlacement }
      : {})
  })
}
