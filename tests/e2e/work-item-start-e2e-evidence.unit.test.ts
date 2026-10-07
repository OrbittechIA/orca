import { describe, expect, it, vi } from 'vitest'
import {
  candidateExpectedCommit,
  requireCandidateManifestPath,
  type CandidateManifest
} from './work-item-start-candidate-manifest'
import { collectWorkItemStartE2eEvidence } from './work-item-start-e2e-collect'
import { WORK_ITEM_START_CAPABILITY, workItemStartE2eDefects } from './work-item-start-e2e-evidence'

// A synthetic candidate: the evidence binds to whatever the manifest names, never a pinned version.
const CANDIDATE_VERSION = '1.4.209'
const COMMIT = '8046116ad55d2b03461c87efd7f20c353dd9b032'
const TREE = 'df262ab6a9de98ef6b271b94c5aafd2da7f153f8'
const BUILD_ID = '7bbdd813f784'

// Another build: a coherent pair on its own, but not the candidate under certification.
const OTHER_BUILD = {
  version: '1.4.208',
  commit: '2b19f21adab5907697ef76ce429bafcd2cfea9ec',
  tree: '798d7351c73012b7319dc4d83b8a2905ac1877c9',
  buildId: '17a4aae22bfc'
}

const CLIENT_ASAR = '1'.repeat(64)
const SERVER_ASAR = '2'.repeat(64)

const MANIFEST: CandidateManifest = {
  version: CANDIDATE_VERSION,
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
      bytes: 120_000_000,
      appContentSha256: CLIENT_ASAR
    },
    {
      artifact: 'Orca-Setup-arm64.exe',
      platform: 'windows',
      arch: 'arm64',
      kind: 'nsis',
      sha256: 'e'.repeat(64),
      bytes: 118_000_000,
      appContentSha256: CLIENT_ASAR
    },
    {
      artifact: 'orca-linux.AppImage',
      platform: 'linux',
      arch: 'x64',
      kind: 'appimage',
      sha256: 'b'.repeat(64),
      bytes: 196_990_796,
      appContentSha256: SERVER_ASAR
    }
  ]
}

const ARTIFACTS = { client: 'Orca-Setup-x64.exe', server: 'orca-linux.AppImage' }

const EMBEDDED = {
  version: CANDIDATE_VERSION,
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
  expectedCommit?: string
}) {
  const readClientProcess = vi.fn(async () => ({
    appVersion: CANDIDATE_VERSION,
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    execPath: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Orca\\Orca.exe',
    buildProvenance: EMBEDDED,
    appContentSha256: CLIENT_ASAR,
    attestationId: '3'.repeat(64),
    ...overrides?.client
  }))
  const readServerStatus = vi.fn(async () => ({
    appVersion: CANDIDATE_VERSION,
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
    appContent: { kind: 'app-asar', sha256: SERVER_ASAR },
    attestationId: '4'.repeat(64),
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
      ...(overrides?.expectedCommit !== undefined
        ? { expectedCommit: overrides.expectedCommit }
        : {}),
      // The client executable is hashed where it runs; the fixture injects it here.
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
  it('reads both sides and accepts a pair running the named candidate', async () => {
    const { readClientProcess, readServerStatus, promise } = collect()
    const evidence = await promise

    expect(readClientProcess).toHaveBeenCalledOnce()
    expect(readServerStatus).toHaveBeenCalledOnce()
    expect(evidence.client.commit).toBe(COMMIT)
    expect(evidence.candidate).toEqual({
      version: CANDIDATE_VERSION,
      commit: COMMIT,
      tree: TREE,
      buildId: BUILD_ID
    })
    expect(evidence.client.appContentSha256).toBe(CLIENT_ASAR)
    expect(evidence.server.appContentSha256).toBe(SERVER_ASAR)
    expect(evidence.client.manifestArtifact).toBe('Orca-Setup-x64.exe')
    expect(evidence.server.manifestArtifact).toBe('orca-linux.AppImage')
    // The running executable hash and the published artifact hash are distinct facts.
    expect(evidence.client.artifactSha256).toBe('c'.repeat(64))
    expect(evidence.client.candidateArtifactSha256).toBe('a'.repeat(64))
    expect(evidence.server.artifactSha256).toBe('d'.repeat(64))
    expect(evidence.server.candidateArtifactSha256).toBe('b'.repeat(64))
    // An equal `buildId` on both sides is expected: it comes from commit+tree.
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

  it('binds to any candidate version the manifest names, with no pinned baseline', async () => {
    const other = { ...MANIFEST, ...OTHER_BUILD }
    const { promise } = collect({
      client: { appVersion: OTHER_BUILD.version, buildProvenance: OTHER_BUILD },
      server: { appVersion: OTHER_BUILD.version, buildProvenance: OTHER_BUILD },
      attestation: { buildProvenance: OTHER_BUILD },
      manifest: other
    })
    const evidence = await promise
    expect(evidence.candidate.version).toBe(OTHER_BUILD.version)
    expect(workItemStartE2eDefects(evidence)).toEqual([])
  })

  it('refuses a side running another build than the candidate, on either side', async () => {
    for (const side of ['server', 'client'] as const) {
      const { promise } = collect({
        [side]: { appVersion: OTHER_BUILD.version, buildProvenance: OTHER_BUILD },
        ...(side === 'server' ? { attestation: { buildProvenance: OTHER_BUILD } } : {})
      })
      const defects = workItemStartE2eDefects(await promise)
      expect(defects).toContain(`${side} is 1.4.208, not the candidate ${CANDIDATE_VERSION}`)
      expect(defects).toContain(`${side} is not bound to the candidate commit and tree`)
      expect(defects).toContain(
        `${side} embedded build identity does not match the candidate manifest`
      )
      expect(defects.some((defect) => defect.endsWith('differ'))).toBe(true)
    }
  })

  it("honours the owner's immutable expected-commit pin", async () => {
    expect(workItemStartE2eDefects(await collect({ expectedCommit: COMMIT }).promise)).toEqual([])
    expect(
      workItemStartE2eDefects(await collect({ expectedCommit: OTHER_BUILD.commit }).promise)
    ).toContain(`candidate manifest is ${COMMIT}, not the expected ${OTHER_BUILD.commit}`)
    expect(
      workItemStartE2eDefects(await collect({ expectedCommit: COMMIT.slice(0, 12) }).promise)
    ).toContain('the expected candidate commit is not a full 40-character sha')
  })

  it('reads the pin from the environment only as a full sha', () => {
    expect(candidateExpectedCommit({})).toBeUndefined()
    expect(candidateExpectedCommit({ ORCA_CANDIDATE_EXPECTED_COMMIT: COMMIT })).toBe(COMMIT)
    expect(() => candidateExpectedCommit({ ORCA_CANDIDATE_EXPECTED_COMMIT: 'main' })).toThrow(
      /full 40-character/
    )
  })

  it('refuses two builds that share an Electron binary but run different app.asar', async () => {
    // Same executable sha on the client as the candidate would have; only app content differs.
    const { promise } = collect({ client: { appContentSha256: '9'.repeat(64) } })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'client app content does not match the candidate artifact'
    )
  })

  it('refuses an unpackaged or unattested side', async () => {
    const unpackaged = await collect({ attestation: { appContent: { kind: 'unpackaged' } } })
      .promise
    expect(workItemStartE2eDefects(unpackaged)).toContain(
      'server did not attest the packaged app content it is running'
    )
    const legacy = await collect({
      client: { appContentSha256: undefined, attestationId: undefined }
    }).promise
    const defects = workItemStartE2eDefects(legacy)
    expect(defects).toContain('client did not attest the packaged app content it is running')
    expect(defects).toContain('client reported no attestation identity')
  })

  it('refuses one attestation identity standing in for both hosts', async () => {
    const { promise } = collect({ attestation: { attestationId: '3'.repeat(64) } })
    expect(workItemStartE2eDefects(await promise)).toContain(
      'one attestation identity for a Windows client and its server; these are two hosts'
    )
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
    // An x64 client pointed at the arm64 NSIS: same platform, impossible binary.
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
