import { describe, expect, it, vi } from 'vitest'
import type { CandidateManifest } from './work-item-start-candidate-manifest'
import { collectWorkItemStartE2eEvidence } from './work-item-start-e2e-collect'
import {
  WORK_ITEM_START_CAPABILITY,
  WORK_ITEM_START_E2E_BASELINE_VERSION,
  workItemStartE2eDefects
} from './work-item-start-e2e-evidence'

const COMMIT = '2b19f21adab5907697ef76ce429bafcd2cfea9ec'
const TREE = '798d7351c73012b7319dc4d83b8a2905ac1877c9'

const BUILD_ID = '238ae8dfd818'

const MANIFEST: CandidateManifest = {
  version: WORK_ITEM_START_E2E_BASELINE_VERSION,
  commit: COMMIT,
  tree: TREE,
  buildId: BUILD_ID,
  artifacts: [
    {
      artifact: 'Orca-Setup-x64.exe',
      platform: 'windows',
      arch: 'x64',
      kind: 'nsis',
      sha256: 'a'.repeat(64),
      bytes: 120_000_000
    },
    {
      artifact: 'Orca-Setup-arm64.exe',
      platform: 'windows',
      arch: 'arm64',
      kind: 'nsis',
      sha256: 'e'.repeat(64),
      bytes: 118_000_000
    },
    {
      artifact: 'orca-linux.AppImage',
      platform: 'linux',
      arch: 'x64',
      kind: 'appimage',
      sha256: 'b'.repeat(64),
      bytes: 196_990_796
    }
  ]
}

const ARTIFACTS = { client: 'Orca-Setup-x64.exe', server: 'orca-linux.AppImage' }

const EMBEDDED = {
  version: WORK_ITEM_START_E2E_BASELINE_VERSION,
  commit: COMMIT,
  tree: TREE,
  buildId: BUILD_ID
}

const outcome = { sessionId: 's-1', promptDeliveries: 1, terminalLocator: null, executors: 1 }

function collect(overrides?: {
  client?: object
  server?: object
  attestation?: object
  manifest?: CandidateManifest
  artifacts?: { client: string; server: string }
}) {
  const readClientProcess = vi.fn(async () => ({
    appVersion: WORK_ITEM_START_E2E_BASELINE_VERSION,
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    execPath: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Orca\\Orca.exe',
    buildProvenance: EMBEDDED,
    ...overrides?.client
  }))
  const readServerStatus = vi.fn(async () => ({
    appVersion: WORK_ITEM_START_E2E_BASELINE_VERSION,
    runtimeId: 'runtime-1',
    capabilities: [WORK_ITEM_START_CAPABILITY],
    buildProvenance: EMBEDDED,
    hostPlatform: 'linux',
    ...overrides?.server
  }))
  const readServerAttestation = vi.fn(async () => ({
    sha256: 'd'.repeat(64),
    bytes: 196_990_796,
    platform: 'linux',
    arch: 'x64',
    buildProvenance: EMBEDDED,
    ...overrides?.attestation
  }))
  return {
    readClientProcess,
    readServerStatus,
    readServerAttestation,
    promise: collectWorkItemStartE2eEvidence({
      now: () => '2026-09-15T00:00:00Z',
      readClientProcess,
      readServerStatus,
      readServerAttestation,
      manifest: overrides?.manifest ?? MANIFEST,
      artifacts: overrides?.artifacts ?? ARTIFACTS,
      outcome,
      // O executável do cliente é hasheado onde ele roda; aqui o fixture o injeta.
      hashFile: (path) => (path ? 'c'.repeat(64) : null)
    })
  }
}

describe('Work Item Start E2E evidence binds running processes to the candidate', () => {
  it('reads both sides and accepts a matched 1.4.201 pair', async () => {
    const { readClientProcess, readServerStatus, promise } = collect()
    const evidence = await promise

    expect(readClientProcess).toHaveBeenCalledOnce()
    expect(readServerStatus).toHaveBeenCalledOnce()
    expect(evidence.client.commit).toBe(COMMIT)
    expect(evidence.client.manifestArtifact).toBe('Orca-Setup-x64.exe')
    expect(evidence.server.manifestArtifact).toBe('orca-linux.AppImage')
    // O hash do executável em execução e o do artefato publicado são fatos distintos.
    expect(evidence.client.artifactSha256).toBe('c'.repeat(64))
    expect(evidence.client.candidateArtifactSha256).toBe('a'.repeat(64))
    expect(evidence.server.artifactSha256).toBe('d'.repeat(64))
    expect(evidence.server.candidateArtifactSha256).toBe('b'.repeat(64))
    // `buildId` igual nos dois lados é o esperado: sai de commit+árvore.
    expect(evidence.client.buildId).toBe(evidence.server.buildId)
    expect(workItemStartE2eDefects(evidence)).toEqual([])
  })

  it('refuses a process whose embedded identity is another commit', async () => {
    const { promise } = collect({
      client: { buildProvenance: { ...EMBEDDED, commit: 'f'.repeat(40) } }
    })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'client embedded build identity does not match the candidate manifest'
    )
  })

  it('refuses a server that exposes no embedded identity at all', async () => {
    const { promise } = collect({
      server: { buildProvenance: null },
      attestation: { buildProvenance: null }
    })
    const evidence = await promise
    expect(evidence.server.provenance).toContain('exposed no buildProvenance')
    expect(workItemStartE2eDefects(evidence)).toContain(
      'server embedded build identity does not match the candidate manifest'
    )
  })

  it('refuses a server that attested no executable of its own', async () => {
    const { promise } = collect({ attestation: { sha256: undefined } })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'server did not report the sha256 of the executable it is running'
    )
  })

  it('refuses a matched pair that is not the 1.4.201 baseline', async () => {
    const older = { ...EMBEDDED, version: '1.4.199' }
    const { promise } = collect({
      client: { appVersion: '1.4.199', buildProvenance: older },
      server: { appVersion: '1.4.199', buildProvenance: older },
      manifest: { ...MANIFEST, version: '1.4.199' }
    })
    // Versões iguais não bastam: 1.4.199 ↔ 1.4.199 é um par casado fora da baseline.
    const defects = await promise.then(workItemStartE2eDefects)
    expect(defects).toContain('server is 1.4.199, not the 1.4.201 baseline')
    expect(defects).toContain('client is 1.4.199, not the 1.4.201 baseline')
  })

  it('refuses a client that is not the Windows Desktop', async () => {
    const { promise } = collect({ client: { platform: 'linux' } })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'client platform is linux, not the Windows Desktop'
    )
  })

  it('refuses a build id that does not match the manifest', async () => {
    const { promise } = collect({
      client: { buildProvenance: { ...EMBEDDED, buildId: 'ffffffffffff' } }
    })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'client embedded build identity does not match the candidate manifest'
    )
  })

  it('refuses an artifact whose arch the running process could not have executed', async () => {
    // Cliente x64 apontado para o NSIS arm64: mesma plataforma, binário impossível.
    const { promise } = collect({
      artifacts: { client: 'Orca-Setup-arm64.exe', server: 'orca-linux.AppImage' }
    })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'client embedded build identity does not match the candidate manifest'
    )
  })

  it('accepts the arm64 artifact for an arm64 client', async () => {
    const { promise } = collect({
      client: { arch: 'arm64' },
      artifacts: { client: 'Orca-Setup-arm64.exe', server: 'orca-linux.AppImage' }
    })
    const evidence = await promise
    expect(evidence.client.manifestArtifact).toBe('Orca-Setup-arm64.exe')
    expect(evidence.client.candidateArtifactSha256).toBe('e'.repeat(64))
  })

  it('refuses one candidate artifact standing in for both hosts', async () => {
    const { promise } = collect({
      attestation: { platform: 'win32' },
      artifacts: { client: 'Orca-Setup-x64.exe', server: 'Orca-Setup-x64.exe' }
    })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'one candidate artifact for a Windows client and its server; these are two builds'
    )
  })

  it('refuses a missing capability and anything but one writer', async () => {
    const noCapability = await collect({ server: { capabilities: [] } }).promise
    expect(workItemStartE2eDefects(noCapability)).toContain(
      `server does not advertise ${WORK_ITEM_START_CAPABILITY}`
    )
    for (const [broken, defect] of [
      [{ ...outcome, promptDeliveries: 2 }, 'prompt delivered 2 times, expected once'],
      [{ ...outcome, terminalLocator: 'term-1' }, 'a terminal writer was left behind'],
      [{ ...outcome, executors: 2 }, '2 executors, expected exactly one'],
      [{ ...outcome, sessionId: null }, 'no structured session was created']
    ] as const) {
      const evidence = await collect().promise
      expect(workItemStartE2eDefects({ ...evidence, outcome: broken })).toContain(defect)
    }
  })
})
