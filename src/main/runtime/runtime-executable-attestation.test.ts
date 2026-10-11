import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attestRuntimeBuild } from './runtime-executable-attestation'

const PROVENANCE = {
  version: '1.4.209',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  buildId: 'c'.repeat(12)
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-attestation-'))
  await writeFile(join(dir, 'electron'), 'the same electron binary')
  await writeFile(join(dir, 'app-one.asar'), 'app code one')
  await writeFile(join(dir, 'app-two.asar'), 'app code two')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function attest(appAsar: string | null) {
  return attestRuntimeBuild({
    execPath: join(dir, 'electron'),
    appAsarPath: appAsar ? join(dir, appAsar) : null,
    buildProvenance: PROVENANCE,
    platform: 'linux',
    arch: 'x64'
  })
}

describe('runtime build attestation', () => {
  it('binds app.asar, so one Electron binary with two app bundles yields two identities', async () => {
    const one = await attest('app-one.asar')
    const two = await attest('app-two.asar')

    // The legacy executable hash cannot tell them apart; that is the gap this closes.
    expect(one?.sha256).toBe(two?.sha256)
    expect(one?.appContent).toMatchObject({ kind: 'app-asar', bytes: 'app code one'.length })
    expect(one?.appContent).not.toEqual(two?.appContent)
    expect(one?.attestationId).toMatch(/^[0-9a-f]{64}$/)
    expect(one?.attestationId).not.toBe(two?.attestationId)
  })

  it('is stable for the same executable, app content and build', async () => {
    expect((await attest('app-one.asar'))?.attestationId).toBe(
      (await attest('app-one.asar'))?.attestationId
    )
  })

  it('reports an unpackaged run explicitly rather than inventing app content', async () => {
    const unpackaged = await attest(null)
    expect(unpackaged?.appContent).toEqual({ kind: 'unpackaged' })
    expect(unpackaged?.attestationId).not.toBe((await attest('app-one.asar'))?.attestationId)
  })

  it('keeps the legacy fields old clients read', async () => {
    expect(await attest('app-one.asar')).toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: 'the same electron binary'.length,
      platform: 'linux',
      arch: 'x64',
      buildProvenance: PROVENANCE
    })
  })

  it('attests nothing when a named app.asar cannot be read', async () => {
    await expect(attest('missing.asar')).resolves.toBeNull()
  })
})
