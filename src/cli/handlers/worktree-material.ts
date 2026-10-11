import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
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
  const filename = getRequiredStringFlag(flags, 'manifest')
  const before = await lstat(filename, { bigint: true })
  const invalid = () =>
    new RuntimeClientError(
      'invalid_argument',
      'Manifest must be one unchanged regular UTF-8 JSON file of at most 16 KiB, with unique keys.'
    )
  if (!before.isFile() || before.size > 16_384n || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) {
    throw invalid()
  }
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const stat = await file.stat({ bigint: true })
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size !== before.size
    ) {
      throw invalid()
    }
    const buffer = Buffer.alloc(16_385)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const after = await file.stat({ bigint: true })
    const locator = await lstat(filename, { bigint: true })
    if (
      BigInt(bytesRead) !== stat.size ||
      bytesRead > 16_384 ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs ||
      after.size !== stat.size ||
      locator.dev !== stat.dev ||
      locator.ino !== stat.ino ||
      !locator.isFile()
    ) {
      throw invalid()
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    const parsed: unknown = JSON.parse(text)
    const keys = new Set<string>()
    for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      if (!/^\s*:/.test(text.slice(token.index + token[0].length))) {
        continue
      }
      const key: unknown = JSON.parse(token[0])
      if (typeof key !== 'string' || keys.has(key)) {
        throw invalid()
      }
      keys.add(key)
    }
    return WorktreeMaterialManifest.parse(parsed)
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
