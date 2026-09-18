import { describe, expect, it } from 'vitest'
import { resolveCodexStructuredAppServerArgs } from './codex-structured-app-server-args'

describe('structured Codex app-server arguments', () => {
  it('keeps configuration flags and converts effort to the app-server config contract', () => {
    expect(
      resolveCodexStructuredAppServerArgs(
        '--profile review -c approval_policy=never --model gpt-5.6 --effort high --search',
        'posix'
      )
    ).toEqual([
      '--profile',
      'review',
      '-c',
      'approval_policy=never',
      '--model',
      'gpt-5.6',
      '-c',
      'model_reasoning_effort=high',
      '--search'
    ])
  })

  it('normalizes Codex YOLO mode into app-server approval and sandbox config', () => {
    expect(
      resolveCodexStructuredAppServerArgs('--dangerously-bypass-approvals-and-sandbox', 'posix')
    ).toEqual(['-c', 'approval_policy=never', '-c', 'sandbox_mode=danger-full-access'])
  })

  it('keeps YOLO as the final override regardless of configured argument order', () => {
    expect(
      resolveCodexStructuredAppServerArgs(
        '--dangerously-bypass-approvals-and-sandbox -c approval_policy=on-request --sandbox workspace-write',
        'posix'
      )
    ).toEqual([
      '-c',
      'approval_policy=on-request',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy=never',
      '-c',
      'sandbox_mode=danger-full-access'
    ])
  })

  it.each(['--no-alt-screen', '--remote ws://host', '-C /tmp/elsewhere', 'resume thread-1'])(
    'reports an incompatible configured argument instead of dropping %s',
    (configured) => {
      expect(() => resolveCodexStructuredAppServerArgs(configured, 'posix')).toThrow(
        /cannot apply the configured CLI arguments.*Settings or use terminal view/
      )
    }
  )
})
