import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
// options reads at-rest records/catalogs or the live provider; modelCatalog reads stored/start-published facts without waiting on attach.
// Older hosts return method_not_found (mobile may see forbidden); clients retain static seeds.

import { defineMethod, type RpcContext } from '../core'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  ensureStructuredHostInstalled,
  requireInstalledStructuredHost,
  requireStructuredAgentAudience,
  requireStructuredHost,
  requireStructuredSessionHost,
  structuredSessionProvablyAbsent
} from './structured-agent-session-gate'
import {
  HandoffStatusParams,
  ContinuationContextParams,
  ModelCatalogParams,
  OptionsParams
} from './structured-agent-session-schemas'
import { agentSessionPinnedLaunchDirectory } from '../../agent-session-record-launch-directory'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  clientRequestsCommands,
  clientReadsOptionsWithoutModel
} from './structured-agent-session-policy'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionOptionModels } from '../../../native-chat/agent-session-wire/structured-agent-session-option-models'
import { finishedListingIds } from '../../../../shared/structured-agent-session-options'

/** A new chat's reserved id is not founded yet: it reads what a new launch sees, unbound so a racing create cannot rebind it. */
async function modelCatalogHost(
  ctx: RpcContext,
  sessionId: string | undefined
): Promise<{ host: StructuredAgentSessionHost; sessionId: string | undefined }> {
  if (sessionId === undefined) {
    return { host: requireStructuredHost(ctx), sessionId }
  }
  await ensureStructuredHostInstalled(ctx)
  const host = requireStructuredHost(ctx)
  if (structuredSessionProvablyAbsent(host, sessionId)) {
    return { host, sessionId: undefined }
  }
  return { host: requireStructuredSessionHost(ctx, sessionId), sessionId }
}

export const STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS = [
  defineMethod({
    name: 'agentSession.continuationContext',
    permission: 'workspace',
    params: ContinuationContextParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).continuationContext(params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    permission: 'workspace',
    params: HandoffStatusParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).readCommands(
        params.sessionId,
        clientRequestsCommands(ctx)
      )
  }),
  defineMethod({
    name: 'agentSession.options',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const readsWithoutModel = clientReadsOptionsWithoutModel(ctx)
      const result = await (
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).readOptions(params.sessionId, { readsWithoutModel })
      if (result.current.model === undefined && !readsWithoutModel) {
        throw agentSessionRefusalError('structured_agent_session_unsupported', {
          reason: 'clientCapabilityMissing'
        })
      }
      return result
    }
  }),
  defineMethod({
    name: 'agentSession.modelCatalog',
    permission: 'workspace',
    params: ModelCatalogParams,
    // Session reads may build the host; session-less terminal reads must not open unused structured journals.
    handler: async ({ worktree, sessionId: namedSessionId, ...rest }, ctx) => {
      requireStructuredAgentAudience(ctx, rest.agent)
      const { host, sessionId } = await modelCatalogHost(ctx, namedSessionId)
      const params = sessionId === undefined ? rest : { ...rest, sessionId }
      const record = sessionId === undefined ? null : host.deps.store.getConversation(sessionId)
      const coherent =
        ctx.clientKind === undefined ||
        ctx.clientCapabilities?.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY) === true
      const scope = coherent ? {} : { legacy: true }
      const read = async (): Promise<AgentSessionModelCatalogResult> => {
        const catalog = host.deps.modelCatalog
        if (!catalog) {
          return { origin: 'unknown' }
        }
        // A floating chat runs in the folder it was created in, not the floating setting's current one.
        const launchDirectory = record ? agentSessionPinnedLaunchDirectory(record) : undefined
        const request = {
          ...params,
          ...scope,
          ...(launchDirectory
            ? { workspacePath: launchDirectory }
            : worktree === undefined
              ? {}
              : {
                  workspace: {
                    selector: worktree,
                    identity: () =>
                      ctx.runtime.structuredAgentSessionCatalogWorkspaceIdentity(worktree),
                    resolve: () => ctx.runtime.resolveStructuredAgentCatalogWorkspace(worktree)
                  }
                })
        }
        if (!params.savedOnly) {
          void catalog.demand(request)
        }
        return catalog.read(request)
      }
      const listing = await read()
      const own = record?.provider === params.agent ? record : null
      // Preserve a reopened chat's own model even if unlisted; new-chat reads instead seed the next picker.
      return !coherent &&
        own &&
        worktree === undefined &&
        finishedListingIds(listing) &&
        listing.origin !== 'unknown'
        ? {
            ...listing,
            models: structuredAgentSessionOptionModels(
              listing.models,
              own.options?.model,
              (row) => row
            )
          }
        : listing
    }
  })
]
