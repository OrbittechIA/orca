import { describe, expect, it } from 'vitest'
import { REPEATED_FLAG_SEPARATOR } from '../../args'
import { readWorkerFilesystemScopeFlags } from './worker-filesystem-scope-flags'

const flags = (entries: Record<string, string>) =>
  new Map<string, string | boolean>(Object.entries(entries))

describe('readWorkerFilesystemScopeFlags', () => {
  it('leaves an unscoped start unchanged', () => {
    expect(readWorkerFilesystemScopeFlags(flags({}))).toBeUndefined()
  })

  it('reads read-only and repeated write roots', () => {
    expect(readWorkerFilesystemScopeFlags(flags({ scope: 'read-only' }))).toEqual({
      version: 1,
      kind: 'read-only'
    })
    expect(
      readWorkerFilesystemScopeFlags(
        flags({ scope: 'write-roots', 'scope-root': `src${REPEATED_FLAG_SEPARATOR}docs` })
      )
    ).toEqual({ version: 1, kind: 'directory-roots', roots: ['src', 'docs'] })
  })

  it.each([
    [{ 'scope-root': 'src' }, /requires --scope write-roots/],
    [{ scope: 'read-only', 'scope-root': 'src' }, /takes no --scope-root/],
    [{ scope: 'files' }, /must be read-only or write-roots/],
    [{ scope: 'write-roots' }, /./],
    [{ scope: 'write-roots', 'scope-root': '../escape' }, /traverse/],
    [{ scope: 'write-roots', 'scope-root': 'src/**/*.ts' }, /glob/]
  ])('refuses %o', (entries, message) => {
    expect(() => readWorkerFilesystemScopeFlags(flags(entries))).toThrow(message)
  })
})
