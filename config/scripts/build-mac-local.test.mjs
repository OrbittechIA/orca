import { describe, expect, it } from 'vitest'
import { createLocalBuildVersion, getLocalBuildIdentity } from './build-mac-local.mjs'

describe('createLocalBuildVersion', () => {
  it('creates unique valid prerelease versions without changing the release base', () => {
    expect(createLocalBuildVersion('1.4.159-rc.0', 123456, 'abc123')).toBe(
      '1.4.159-rc.0.local.123456.abc123'
    )
    expect(createLocalBuildVersion('1.4.159', 123456, 'abc123')).toBe('1.4.159-local.123456.abc123')
  })

  it('sanitizes commit identifiers', () => {
    expect(createLocalBuildVersion('1.0.0', 1, 'abc/def')).toBe('1.0.0-local.1.abcdef')
  })
})

describe('getLocalBuildIdentity', () => {
  const FULL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
  const packageJsonPath = new URL('../../package.json', import.meta.url).pathname

  it('hands the packager the full commit and keeps the short suffix for the human version', () => {
    // The verifier compares `ORCA_BUILD_COMMIT` with `git rev-parse HEAD` byte for byte: a
    // --short=12 value made the local mac build refuse its own identity.
    const run = (command, args) => {
      expect(command).toBe('git')
      expect(args).toEqual(['rev-parse', 'HEAD'])
      return `${FULL}\n`
    }
    const identity = getLocalBuildIdentity({ run, now: () => 123456, packageJsonPath })
    expect(identity.commit).toBe(FULL)
    expect(identity.version).toMatch(/-local\.123456\.a1b2c3d4e5f6$|\.local\.123456\.a1b2c3d4e5f6$/)
  })

  it('refuses anything but a full commit', () => {
    expect(() =>
      getLocalBuildIdentity({ run: () => 'a1b2c3d4e5f6\n', now: () => 1, packageJsonPath })
    ).toThrow(/full commit/)
  })
})
