// `agentSession.create` / `createSupport`, split out so the method table stays under the
// file-size limit. Both carry the scoped Work Item Start admission: a create that declares
// `launchOrigin` is gated by server-resolved authority, never by a client assertion.
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'
import { defineMethod } from '../core'
import {
  canAccessWorkItemStartStructuredSession,
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredCreateHost,
  resolveWorkItemStartStructuredCreateAuthority,
  structuredCallerFor as callerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import { supportsWorkItemStartStructuredSessionCreate } from './structured-agent-session-policy'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree
} from './structured-agent-session-create'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { resolveClientSuppliedAttach } from './structured-agent-session'
import { CreateParams, CreateSupportParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_CREATE_METHODS = [
  defineMethod({
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
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
        throw new Error('structured_agent_session_unsupported')
      }
      const scopedAdmission =
        params.launchOrigin &&
        !reconcilesDurableSession &&
        supportsWorkItemStartStructuredSessionCreate(ctx, params.launchOrigin)
          ? await resolveWorkItemStartStructuredCreateAuthority(ctx, params.worktree)
          : null
      const admitted = params.launchOrigin
        ? scopedAdmission !== null || reconcilesDurableSession
        : supportsStructuredSessions(ctx)
      if (!admitted) {
        throw new Error('structured_agent_session_unsupported')
      }
      if (reconcilesDurableSession) {
        return { supported: true }
      }
      return ctx.runtime.getStructuredAgentSessionCreateSupport(
        scopedAdmission ? `id:${scopedAdmission.worktreeTarget.worktreeId}` : params.worktree,
        params.agent
      )
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
        throw new Error('structured_agent_session_unsupported')
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
        throw new Error('structured_agent_session_unsupported')
      }
      if (params.envelope.expectedRuntimeFence !== null) {
        throw new Error('agent_session_operation_invalid')
      }
      const persistedLaunchAuthority = reconcilesDurableSession
        ? existingRecord?.launchAuthority
        : undefined
      // Everything up to `attach` is pre-commit, and answers with a refusal rather than a throw so
      // a client can tell "nothing was created" from "the outcome is unknown".
      const prepared = await resolveUncommittedStructuredCreate(async () => {
        if ('worktree' in params) {
          const intentFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: params.envelope.sessionId,
            // `resumeFrom` is part of the intent, not a detail of it: without it here, a retry of
            // "adopt this conversation" would replay as, or conflict with, a blank create. The
            // canonicalizer drops `undefined`, so plain creates keep the digest they always had.
            fields: {
              worktree: params.worktree,
              agent: params.agent,
              resumeFrom: params.resumeFrom,
              launchOrigin: params.launchOrigin
            }
          })
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
