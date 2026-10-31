import { WorktreeCustodyRequestSchema } from '../../shared/worktree/custody-schema'
import { WORKTREE_CUSTODY_CAPABILITY } from '../../shared/worktree/custody'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

export const worktreeCustody: CommandHandler = async ({ flags, client, json }) => {
  const parse = (flag: string): unknown => {
    const value = getOptionalStringFlag(flags, flag)
    if (value === undefined) {
      return undefined
    }
    if (value.length > 65536) {
      throw new RuntimeClientError('invalid_argument', `--${flag} is too large`)
    }
    try {
      return JSON.parse(value)
    } catch {
      throw new RuntimeClientError(
        'invalid_argument',
        `--${flag} requires JSON from the native custody response`
      )
    }
  }
  const operation = getRequiredStringFlag(flags, 'operation')
  const request = WorktreeCustodyRequestSchema.safeParse({
    schemaVersion: 1,
    operation,
    ...(flags.has('resource') ? { resource: parse('resource') } : {}),
    ...(flags.has('fence') ? { fence: parse('fence') } : {}),
    ...(flags.has('key') ? { key: getRequiredStringFlag(flags, 'key') } : {})
  })
  if (!request.success) {
    throw new RuntimeClientError('invalid_argument', request.error.message)
  }
  if (operation === 'capture' || operation === 'retire') {
    const status = await client.call<{ capabilities?: string[] }>('status.get')
    if (!status.result.capabilities?.includes(WORKTREE_CUSTODY_CAPABILITY)) {
      throw new RuntimeClientError(
        'custody_coverage_unsupported',
        'This host has no verified no-stop custody provider. Preserve this resource.'
      )
    }
  }
  const result = await client.call('worktree.custody.v1', request.data)
  printResult(result, json, (value) => JSON.stringify(value, null, 2))
}
