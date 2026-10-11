import { open } from 'node:fs/promises'
import {
  MaterialRequestId,
  WorktreeMaterialManifest,
  WorktreeMaterialRestore
} from '../../shared/rpc-contract/worktree-material-params'
import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

async function readMaterialManifest(flags: Map<string, string | boolean>) {
  const file = await open(getRequiredStringFlag(flags, 'manifest'), 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 16_384)
      throw new RuntimeClientError(
        'invalid_argument',
        'Manifest must be a regular file of at most 16 KiB.'
      )
    const buffer = Buffer.alloc(16_385)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 16_384)
      throw new RuntimeClientError('invalid_argument', 'Manifest exceeds 16 KiB.')
    return WorktreeMaterialManifest.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)))
  } finally {
    await file.close()
  }
}

export const WORKTREE_MATERIAL_HANDLERS: Record<string, CommandHandler> = {
  'worktree material-plan': async ({ flags, client, json }) => {
    const result = await client.call('worktree.materialPlan', {
      manifest: await readMaterialManifest(flags)
    })
    printResult(result, json, (value) => JSON.stringify(value))
  },
  'worktree material-restore': async ({ flags, client, json }) => {
    const requestId = MaterialRequestId.parse(getRequiredStringFlag(flags, 'request-id'))
    const params = WorktreeMaterialRestore.parse({
      requestId,
      manifest: await readMaterialManifest(flags)
    })
    const result = await client.call('worktree.materialRestore', params, {
      orchestrationRequestId: requestId
    })
    printResult(result, json, (value) => JSON.stringify(value))
  },
  'worktree material-show': async ({ flags, client, json }) => {
    const requestId = MaterialRequestId.parse(getRequiredStringFlag(flags, 'request-id'))
    const result = await client.call('worktree.materialShow', { requestId })
    printResult(result, json, (value) => JSON.stringify(value))
  }
}
