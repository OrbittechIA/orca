import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Work Item Start E2E evidence, captured AUTOMATICALLY from both sides.
 *
 * Nothing here is typed in: each side declares its own version, build and binary hashes, and each
 * value travels with the provenance of where it was read. Both sides are bound to ONE candidate,
 * read from the candidate manifest, never to a version pinned in code.
 */
export const WORK_ITEM_START_CAPABILITY = 'agent-session.work-item-start.v1'

const FULL_SHA = /^[0-9a-f]{40}$/

/** The exact build being certified, taken from the candidate manifest. */
export type WorkItemStartE2eCandidate = {
  version: string
  commit: string
  tree: string
  buildId: string
  /** The owner's immutable pin, when given: the manifest must name exactly this commit. */
  expectedCommit?: string
}

/** What each side declares about itself. `provenance` names the surface that declared it. */
export type WorkItemStartE2eSide = {
  appVersion: string
  /** Effective build of this side, from its embedded identity. */
  buildId: string | null
  commit: string | null
  tree: string | null
  /** Path of the RUNNING executable observed on this side. */
  artifactPath: string | null
  /** sha256 of the running Electron executable; shared by every build on one Electron version. */
  artifactSha256: string | null
  /** sha256 of the `app.asar` this side is running: what distinguishes two builds. */
  appContentSha256: string | null
  /** The host's own identity over executable, app content and build id. */
  attestationId: string | null
  /** Candidate artifact matching this side; `null` when the identity does not match. */
  manifestArtifact: string | null
  /** Hash and size of the published artifact, a fact distinct from the running executable hash. */
  candidateArtifactSha256: string | null
  candidateArtifactBytes: number | null
  /** `app.asar` hash the candidate recorded for that artifact at packaging time. */
  candidateAppContentSha256: string | null
  /** Where the fields above came from; required, even when some are null. */
  provenance: string
}

export type WorkItemStartE2eEvidence = {
  capturedAt: string
  candidate: WorkItemStartE2eCandidate
  server: WorkItemStartE2eSide & {
    runtimeId?: string
    capabilities: readonly string[]
    hasWorkItemStartCapability: boolean
  }
  client: WorkItemStartE2eSide & {
    /** Raw, as the client reported it. */
    platform: string
    /** Normalized to the OS family; the owner's E2E runs on the Windows Desktop. */
    platformNormalized: 'windows' | 'macos' | 'linux' | 'unknown'
    osRelease?: string
    arch?: string
    capabilities?: readonly string[]
  }
  outcome: {
    sessionId: string | null
    promptDeliveries: number
    terminalLocator: string | null
    executors: number
  }
}

const EVIDENCE_DIR = path.join(process.cwd(), '.tmp', 'work-item-start-e2e')

export function sha256OfFile(filePath: string | null): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null
  }
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** Windows arrives as `win32` (Node/Electron) or `Windows_NT` (os.type). */
export function normalizeE2ePlatform(platform: string | undefined): {
  platformNormalized: WorkItemStartE2eEvidence['client']['platformNormalized']
} {
  const raw = (platform ?? '').toLowerCase()
  if (raw.startsWith('win')) {
    return { platformNormalized: 'windows' }
  }
  if (raw === 'darwin' || raw.startsWith('mac')) {
    return { platformNormalized: 'macos' }
  }
  return { platformNormalized: raw.startsWith('linux') ? 'linux' : 'unknown' }
}

type CapturedSideInput = {
  appVersion?: string
  buildId?: string | null
  commit?: string | null
  tree?: string | null
  artifactPath: string | null
  artifactSha256?: string | null
  appContentSha256?: string | null
  attestationId?: string | null
  manifestArtifact?: string | null
  candidateArtifact?: {
    artifact: string
    sha256: string
    bytes: number
    appContentSha256?: string
  } | null
  provenance: string
}

function captureSide(input: CapturedSideInput): WorkItemStartE2eSide {
  return {
    appVersion: input.appVersion ?? 'unknown',
    buildId: input.buildId ?? null,
    commit: input.commit ?? null,
    tree: input.tree ?? null,
    artifactPath: input.artifactPath,
    artifactSha256: input.artifactSha256 ?? sha256OfFile(input.artifactPath),
    appContentSha256: input.appContentSha256 ?? null,
    attestationId: input.attestationId ?? null,
    manifestArtifact: input.manifestArtifact ?? null,
    candidateArtifactSha256: input.candidateArtifact?.sha256 ?? null,
    candidateArtifactBytes: input.candidateArtifact?.bytes ?? null,
    candidateAppContentSha256: input.candidateArtifact?.appContentSha256 ?? null,
    provenance: input.provenance
  }
}

export function buildWorkItemStartE2eEvidence(args: {
  now: string
  candidate: WorkItemStartE2eCandidate
  server: CapturedSideInput & { runtimeId?: string; capabilities?: readonly string[] }
  client: CapturedSideInput & {
    platform?: string
    osRelease?: string
    arch?: string
    capabilities?: readonly string[]
  }
  outcome: WorkItemStartE2eEvidence['outcome']
}): WorkItemStartE2eEvidence {
  const capabilities = args.server.capabilities ?? []
  return {
    capturedAt: args.now,
    candidate: args.candidate,
    server: {
      ...captureSide(args.server),
      ...(args.server.runtimeId ? { runtimeId: args.server.runtimeId } : {}),
      capabilities,
      hasWorkItemStartCapability: capabilities.includes(WORK_ITEM_START_CAPABILITY)
    },
    client: {
      ...captureSide(args.client),
      platform: args.client.platform ?? 'unknown',
      ...normalizeE2ePlatform(args.client.platform),
      ...(args.client.osRelease ? { osRelease: args.client.osRelease } : {}),
      ...(args.client.arch ? { arch: args.client.arch } : {}),
      ...(args.client.capabilities ? { capabilities: args.client.capabilities } : {})
    },
    outcome: args.outcome
  }
}

function candidateDefects(candidate: WorkItemStartE2eCandidate): string[] {
  const defects: string[] = []
  if (!FULL_SHA.test(candidate.commit) || !FULL_SHA.test(candidate.tree)) {
    defects.push('candidate manifest does not name a full commit and tree')
  }
  if (!candidate.version.trim() || !candidate.buildId.trim()) {
    defects.push('candidate manifest names no version or build id')
  }
  if (candidate.expectedCommit !== undefined) {
    if (!FULL_SHA.test(candidate.expectedCommit)) {
      defects.push('the expected candidate commit is not a full 40-character sha')
    } else if (candidate.expectedCommit !== candidate.commit) {
      defects.push(
        `candidate manifest is ${candidate.commit}, not the expected ${candidate.expectedCommit}`
      )
    }
  }
  return defects
}

function sideDefects(
  label: string,
  side: WorkItemStartE2eSide,
  candidate: WorkItemStartE2eCandidate
): string[] {
  const defects: string[] = []
  if (side.appVersion !== candidate.version) {
    defects.push(`${label} is ${side.appVersion}, not the candidate ${candidate.version}`)
  }
  if (!side.buildId) {
    defects.push(`${label} reported no effective build id`)
  } else if (side.buildId !== candidate.buildId) {
    defects.push(`${label} build ${side.buildId} is not the candidate build ${candidate.buildId}`)
  }
  if (side.commit !== candidate.commit || side.tree !== candidate.tree) {
    defects.push(`${label} is not bound to the candidate commit and tree`)
  }
  if (!side.candidateArtifactSha256) {
    defects.push(`${label} names no published candidate artifact`)
  }
  if (!side.provenance.trim()) {
    defects.push(`${label} did not name where its version and build came from`)
  }
  if (!side.manifestArtifact) {
    // Bound by embedded identity, not installer bytes: an installer never hashes like the
    // executable it installs, so demanding equality would be an impossible gate.
    defects.push(`${label} embedded build identity does not match the candidate manifest`)
  }
  if (!side.artifactSha256) {
    defects.push(`${label} did not report the sha256 of the executable it is running`)
  }
  if (!side.appContentSha256) {
    defects.push(`${label} did not attest the packaged app content it is running`)
  } else if (side.appContentSha256 !== side.candidateAppContentSha256) {
    defects.push(`${label} app content does not match the candidate artifact`)
  }
  if (!side.attestationId) {
    defects.push(`${label} reported no attestation identity`)
  }
  return defects
}

/**
 * An E2E counts as positive only when both sides run the one candidate, the client is the Windows
 * Desktop, each side binds its own executable AND app content, and a single writer delivered the
 * prompt once.
 */
export function workItemStartE2eDefects(evidence: WorkItemStartE2eEvidence): string[] {
  const defects = [
    ...candidateDefects(evidence.candidate),
    ...sideDefects('server', evidence.server, evidence.candidate),
    ...sideDefects('client', evidence.client, evidence.candidate)
  ]
  if (evidence.server.appVersion !== evidence.client.appVersion) {
    defects.push(
      `server ${evidence.server.appVersion} and client ${evidence.client.appVersion} differ`
    )
  }
  if (evidence.client.platformNormalized !== 'windows') {
    defects.push(`client platform is ${evidence.client.platform}, not the Windows Desktop`)
  }
  // `buildId` comes from commit+tree, so it is EQUAL on both sides of one candidate. What must
  // differ is what each host runs: the attestation identity binds executable and app content.
  if (
    evidence.server.attestationId !== null &&
    evidence.server.attestationId === evidence.client.attestationId
  ) {
    defects.push(
      'one attestation identity for a Windows client and its server; these are two hosts'
    )
  }
  if (
    evidence.server.candidateArtifactSha256 !== null &&
    evidence.server.candidateArtifactSha256 === evidence.client.candidateArtifactSha256
  ) {
    defects.push('one candidate artifact for a Windows client and its server; these are two builds')
  }
  if (!evidence.server.hasWorkItemStartCapability) {
    defects.push(`server does not advertise ${WORK_ITEM_START_CAPABILITY}`)
  }
  if (!evidence.outcome.sessionId) {
    defects.push('no structured session was created')
  }
  if (evidence.outcome.promptDeliveries !== 1) {
    defects.push(`prompt delivered ${evidence.outcome.promptDeliveries} times, expected once`)
  }
  if (evidence.outcome.terminalLocator !== null) {
    defects.push('a terminal writer was left behind')
  }
  if (evidence.outcome.executors !== 1) {
    defects.push(`${evidence.outcome.executors} executors, expected exactly one`)
  }
  return defects
}

export function persistWorkItemStartE2eEvidence(
  label: string,
  evidence: WorkItemStartE2eEvidence
): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const target = path.join(EVIDENCE_DIR, `${label}.json`)
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`)
  return target
}
