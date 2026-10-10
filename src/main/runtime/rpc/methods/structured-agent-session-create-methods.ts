import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
// `agentSession.create` / `createSupport`, split out so the method table stays under the
// file-size limit. Both carry the scoped Work Item Start admission: a create that declares
// `launchOrigin` is gated by server-resolved authority, never by a client assertion.
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionFingerprintConflict } from '../../../../shared/agent-session-mutation-envelope'
import { defineMethod } from '../core'
import {
  canAccessWorkItemStartStructuredSession,
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredCreateSupportAdmission,
  requireStructuredCreateHost,
  resolveWorkItemStartStructuredCreateAuthority,
  structuredCallerFor as callerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import { supportsWorkItemStartStructuredSessionCreate } from './structured-agent-session-policy'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { resolveClientSuppliedAttach } from './structured-agent-session'
import { CreateParams, CreateSupportParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_CREATE_METHODS = [
  defineMethod({
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      if (!params.launchOrigin) {
        requireStructuredCreateSupportAdmission(ctx)
      }
      if (params.repo !== undefined) {
        // Pre-create: same scoped gate, then the source repo's own runtime, before any workspace.
        if (!supportsWorkItemStartStructuredSessionCreate(ctx, params.launchOrigin)) {
          throw agentSessionRefusalError('structured_agent_session_unsupported', {
            reason: 'clientCapabilityMissing'
          })
        }
        return ctx.runtime.getWorkItemStartPreCreateSupport(params.repo, params.agent)
      }
      const worktree = params.worktree
      if (worktree === undefined) {
        throw new Error('Invalid worktree selector')
      }
      // Sem `launchOrigin` o caminho é o da 1.4.201, intacto. Com ele, a admissão é a
      // estreita do Work Item Start: escopo resolvido no servidor, nunca asserido pelo
      // cliente, e uma sessão já existente só passa se este chamador puder alcançá-la.
      if (params.launchOrigin && params.sessionId) {
        await ensureHostInstalled(ctx, {
          sessionId: params.sessionId,
          launchOrigin: params.launchOrigin
        })
      }
      const reconcilesDurableSession =
        params.launchOrigin === 'work-item-start' &&
        params.sessionId !== undefined &&
        canAccessWorkItemStartStructuredSession(ctx, params.sessionId)
      const existingRecord =
        params.launchOrigin && params.sessionId
          ? getStructuredAgentSessionHost()?.deps?.store?.getRecord?.(params.sessionId)
          : null
      if (existingRecord && !reconcilesDurableSession) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      const scopedAdmission =
        params.launchOrigin &&
        !reconcilesDurableSession &&
        supportsWorkItemStartStructuredSessionCreate(ctx, params.launchOrigin)
          ? await resolveWorkItemStartStructuredCreateAuthority(ctx, worktree)
          : null
      const admitted = params.launchOrigin
        ? scopedAdmission !== null || reconcilesDurableSession
        : supportsStructuredSessions(ctx)
      if (!admitted) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      if (reconcilesDurableSession) {
        return { supported: true }
      }
      const support = await ctx.runtime.getStructuredAgentSessionCreateSupport(
        scopedAdmission ? `id:${scopedAdmission.worktreeTarget.worktreeId}` : worktree,
        params.agent
      )
      const seedOptions = support.supported
        ? ctx.runtime.structuredAgentSessionLaunchSeedOptions?.(params.agent)
        : undefined
      return seedOptions ? { ...support, seedOptions } : support
    }
  }),
  defineMethod({
    name: 'agentSession.create',
    params: CreateParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      const launchOrigin = 'worktree' in params ? params.launchOrigin : undefined
      if (launchOrigin) {
        await ensureHostInstalled(ctx, {
          sessionId: params.envelope.sessionId,
          launchOrigin
        })
      }
      const reconcilesDurableSession = Boolean(
        launchOrigin && canAccessWorkItemStartStructuredSession(ctx, params.envelope.sessionId)
      )
      const existingRecord = launchOrigin
        ? getStructuredAgentSessionHost()?.deps?.store?.getRecord?.(params.envelope.sessionId)
        : null
      // Uma sessão já existente que este chamador não alcança nunca é recriada: recriar
      // seria o segundo writer que este caminho existe para impedir.
      if (existingRecord && !reconcilesDurableSession) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      const scopedAdmission =
        'worktree' in params &&
        launchOrigin &&
        !reconcilesDurableSession &&
        supportsWorkItemStartStructuredSessionCreate(ctx, launchOrigin)
          ? await resolveWorkItemStartStructuredCreateAuthority(ctx, params.worktree)
          : null
      const admitted = launchOrigin
        ? scopedAdmission !== null || reconcilesDurableSession
        : supportsStructuredSessions(ctx)
      if (!admitted) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      if (params.envelope.expectedRuntimeFence !== null) {
        throw agentSessionRefusalError('agent_session_operation_invalid', {
          reason: 'requestMalformed'
        })
      }
      const persistedLaunchAuthority = reconcilesDurableSession
        ? existingRecord?.launchAuthority
        : undefined
      // Everything up to `attach` is pre-commit, and answers with a refusal rather than a throw so
      // a client can tell "nothing was created" from "the outcome is unknown".
      const prepared = await resolveUncommittedStructuredCreate(async () => {
        if ('worktree' in params) {
          const intentFingerprint = structuredAgentSessionCreateIntentFingerprint(params)
          const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
          if (conflict) {
            return { refusal: conflict }
          }
          return prepareStructuredAgentSessionCreateForWorktree({
            runtime: ctx.runtime,
            ensureHost: async () => {
              await ensureHostInstalled(ctx, {
                sessionId: params.envelope.sessionId,
                launchOrigin: params.launchOrigin
              })
              return requireStructuredCreateHost(
                ctx,
                params.launchOrigin,
                params.envelope.sessionId
              )
            },
            envelope: params.envelope,
            worktree: params.worktree,
            agent: params.agent as 'claude' | 'codex',
            caller: callerFor(ctx),
            ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
            ...(params.tabId ? { tabId: params.tabId } : {}),
            ...(params.launchOrigin ? { launchOrigin: params.launchOrigin } : {}),
            ...(scopedAdmission
              ? {
                  launchAuthority: scopedAdmission.launchAuthority,
                  expectedWorktreeTarget: scopedAdmission.worktreeTarget
                }
              : persistedLaunchAuthority
                ? { launchAuthority: persistedLaunchAuthority }
                : {})
          })
        }
        const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
        // A client-supplied location names no workspace record to hold or re-check.
        return {
          host,
          attachParams,
          tab: null,
          releaseWorktreeLifecycle: () => {},
          expectedWorktreeTarget: null
        }
      })
      if ('refusal' in prepared) {
        return { ok: false, refusal: prepared.refusal }
      }
      return commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller: callerFor(ctx),
        prepared,
        activate: true
      })
    }
  })
]
