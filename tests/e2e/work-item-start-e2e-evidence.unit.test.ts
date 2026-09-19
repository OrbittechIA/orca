import { describe, expect, it, vi } from 'vitest'
import {
  requireCandidateManifestPath,
  type CandidateManifest
} from './work-item-start-candidate-manifest'
import { collectWorkItemStartE2eEvidence } from './work-item-start-e2e-collect'
import {
  WORK_ITEM_START_CAPABILITY,
  WORK_ITEM_START_E2E_BASELINE_VERSION,
  workItemStartE2eDefects
} from './work-item-start-e2e-evidence'

// A base oficial v1.4.203; o `buildId` é o que `build-provenance.mjs` deriva de commit:árvore.
const COMMIT = '776e424e76405a06851dd9ec9ff3b58ffbdb3eea'
const TREE = 'df262ab6a9de98ef6b271b94c5aafd2da7f153f8'
const BUILD_ID = '7bbdd813f784'

// O checkpoint 1.4.201 anterior: um par casado e coerente que a baseline 1.4.203 recusa.
const PREVIOUS_BASELINE = {
  version: '1.4.201',
  commit: '2b19f21adab5907697ef76ce429bafcd2cfea9ec',
  tree: '798d7351c73012b7319dc4d83b8a2905ac1877c9',
  buildId: '17a4aae22bfc'
}

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

describe('a paired run without a candidate manifest cannot count as a pass', () => {
  it('throws when no manifest is named', () => {
    expect(() => requireCandidateManifestPath({})).toThrow(/cannot count as a pass/)
    expect(() => requireCandidateManifestPath({ ORCA_CANDIDATE_MANIFEST: '  ' })).toThrow(
      /cannot count as a pass/
    )
  })

  it('throws when the named manifest does not exist', () => {
    expect(() =>
      requireCandidateManifestPath({ ORCA_CANDIDATE_MANIFEST: '/nonexistent/manifest.json' })
    ).toThrow(/does not exist/)
  })

  it('returns the path of a manifest that exists', () => {
    expect(requireCandidateManifestPath({ ORCA_CANDIDATE_MANIFEST: __filename })).toBe(__filename)
  })
})

describe('Work Item Start E2E evidence binds running processes to the candidate', () => {
  it('binds the certification to the 1.4.203 candidate baseline', () => {
    expect(WORK_ITEM_START_E2E_BASELINE_VERSION).toBe('1.4.203')
  })

  it('reads both sides and accepts a matched 1.4.203 pair', async () => {
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

  it.each([
    ['1.4.199', { ...EMBEDDED, version: '1.4.199' }, { ...MANIFEST, version: '1.4.199' }],
    ['1.4.201', PREVIOUS_BASELINE, { ...MANIFEST, ...PREVIOUS_BASELINE }]
  ])(
    'refuses a matched %s pair that is not the 1.4.203 baseline',
    async (version, embedded, manifest) => {
      const { promise } = collect({
        client: { appVersion: version, buildProvenance: embedded },
        server: { appVersion: version, buildProvenance: embedded },
        attestation: { buildProvenance: embedded },
        manifest
      })
      const evidence = await promise
      // O par é coerente consigo mesmo — identidade embutida casa com o próprio manifest —
      // e mesmo assim não é a baseline: só a versão o recusa, e recusa os dois lados.
      expect(evidence.client.manifestArtifact).toBe('Orca-Setup-x64.exe')
      expect(evidence.server.manifestArtifact).toBe('orca-linux.AppImage')
      const defects = workItemStartE2eDefects(evidence)
      expect(defects).toContain(`server is ${version}, not the 1.4.203 baseline`)
      expect(defects).toContain(`client is ${version}, not the 1.4.203 baseline`)
    }
  )

  it('refuses a 1.4.201 server behind a 1.4.203 client, and the reverse', async () => {
    for (const side of ['server', 'client'] as const) {
      const { promise } = collect({
        [side]: { appVersion: PREVIOUS_BASELINE.version, buildProvenance: PREVIOUS_BASELINE },
        ...(side === 'server' ? { attestation: { buildProvenance: PREVIOUS_BASELINE } } : {})
      })
      const defects = workItemStartE2eDefects(await promise)
      expect(defects).toContain(`${side} is 1.4.201, not the 1.4.203 baseline`)
      // A identidade 1.4.201 não casa com o manifest 1.4.203: o vínculo por commit/árvore
      // continua a segunda barreira, independente da versão.
      expect(defects).toContain(
        `${side} embedded build identity does not match the candidate manifest`
      )
      expect(defects.some((defect) => defect.endsWith('differ'))).toBe(true)
    }
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
