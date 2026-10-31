import { defineMethod } from '../core'
import { nativeWorktreeCustody } from '../../worktree-custody-runtime'
import { WorktreeCustodyRequestSchema } from '../../../../shared/worktree/custody-schema'
import { observeNativeWorktreeCustody } from '../../worktree-custody-observation'

export const WORKTREE_CUSTODY_METHOD = defineMethod({
  name: 'worktree.custody.v1',
  permission: 'workspace',
  params: WorktreeCustodyRequestSchema,
  handler: async (params, { runtime }) => {
    const custody = nativeWorktreeCustody(runtime.getRuntimeId())
    custody?.installObserver('orchestration', (resource) =>
      observeNativeWorktreeCustody(runtime, resource)
    )
    if (params.operation === 'list') {
      return {
        schemaVersion: 1,
        supported: custody?.supported === true,
        authorityId: custody?.authorityId ?? null,
        resources: custody?.resources() ?? [],
        complete: custody?.complete === true,
        scope: 'native-enrolled-only'
      }
    }
    if (!custody) throw new Error('custody_host_unsupported')
    switch (params.operation) {
      case 'observe':
        return { schemaVersion: 1, observation: await custody.observe(params.resource) }
      case 'capture':
        return { schemaVersion: 1, fence: await custody.capture(params.resource) }
      case 'check':
        custody.check(params.fence)
        return { schemaVersion: 1, valid: true }
      case 'cancel':
        await custody.cancel(params.fence)
        return { schemaVersion: 1, cancelled: true }
      case 'retire':
        return { schemaVersion: 1, outcome: await custody.retire(params.fence, params.key) }
      case 'reconcile':
        return { schemaVersion: 1, outcome: await custody.reconcile(params.resource, params.key) }
    }
  }
})
