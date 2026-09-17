import { describe, expect, it } from 'vitest'
import { classifyWorktreeScanFailure } from './worktree-scan-failure'

describe('classifyWorktreeScanFailure', () => {
  it('recognizes Xcode license failures', () => {
    expect(
      classifyWorktreeScanFailure('Agreeing to the Xcode/iOS license requires admin privileges')
    ).toMatchObject({ kind: 'xcode-license', fixCommand: 'sudo xcodebuild -license' })
  })
  it('recognizes missing developer tools', () => {
    expect(
      classifyWorktreeScanFailure('xcode-select: error: no developer tools were found')
    ).toMatchObject({ kind: 'developer-tools', fixCommand: 'xcode-select --install' })
  })
  it('does not prescribe installation for an unspecified xcode-select path error', () => {
    expect(
      classifyWorktreeScanFailure('xcode-select: error: invalid active developer path')
    ).toMatchObject({ kind: 'unknown' })
  })
  it('recognizes architecture spawn failures', () => {
    expect(classifyWorktreeScanFailure('spawn Unknown system error -86')).toMatchObject({
      kind: 'architecture-mismatch'
    })
  })
})
