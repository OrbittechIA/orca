import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Evidência do E2E Work Item Start, capturada AUTOMATICAMENTE dos dois lados.
 *
 * Nada aqui é digitado: cada lado declara a própria versão, o próprio build e o hash do
 * próprio artefato, e cada valor viaja com a proveniência de onde foi lido. Um único hash
 * "genérico" não serve — cliente Windows e servidor são binários distintos, e uma prova
 * que os confunde não amarra o candidato a coisa nenhuma.
 */
export const WORK_ITEM_START_CAPABILITY = 'agent-session.work-item-start.v1'

/**
 * A baseline vinculante do owner: Desktop e servidor sobem juntos, ambos em 1.4.203.
 *
 * Fixa aqui, e não derivada do manifest: o manifest diz o que foi EMPACOTADO, esta constante
 * diz o que o owner CERTIFICA. Um manifest 1.4.201 casado com processos 1.4.201 é um par
 * coerente e ainda assim fora da baseline — e é o validador que precisa recusá-lo.
 */
export const WORK_ITEM_START_E2E_BASELINE_VERSION = '1.4.203'

/** O que cada lado declara de si mesmo. `provenance` nomeia a superfície que o declarou. */
export type WorkItemStartE2eSide = {
  appVersion: string
  /** Build efetivo do lado, derivado do binário observado. */
  buildId: string | null
  /** Commit e árvore vêm do manifest do candidato — nenhuma das duas superfícies os expõe. */
  commit: string | null
  tree: string | null
  /** O caminho do binário EM EXECUÇÃO observado deste lado. */
  artifactPath: string | null
  artifactSha256: string | null
  /** Artefato do candidato correspondente a este lado; `null` quando a identidade não casa. */
  manifestArtifact: string | null
  /** Hash e tamanho do artefato publicado — fato distinto do hash do executável observado. */
  candidateArtifactSha256: string | null
  candidateArtifactBytes: number | null
  /** De onde vieram os campos acima; obrigatório, inclusive quando algum for nulo. */
  provenance: string
}

export type WorkItemStartE2eEvidence = {
  capturedAt: string
  server: WorkItemStartE2eSide & {
    runtimeId?: string
    capabilities: readonly string[]
    hasWorkItemStartCapability: boolean
  }
  client: WorkItemStartE2eSide & {
    /** Cru, como o cliente reportou. */
    platform: string
    /** Normalizado para a família de SO; o E2E do owner é no Desktop Windows. */
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

/** Windows chega como `win32` (Node/Electron) ou `Windows_NT` (os.type). */
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
  manifestArtifact?: string | null
  candidateArtifact?: { artifact: string; sha256: string; bytes: number } | null
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
    manifestArtifact: input.manifestArtifact ?? null,
    candidateArtifactSha256: input.candidateArtifact?.sha256 ?? null,
    candidateArtifactBytes: input.candidateArtifact?.bytes ?? null,
    provenance: input.provenance
  }
}

export function buildWorkItemStartE2eEvidence(args: {
  now: string
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

function sideDefects(label: string, side: WorkItemStartE2eSide): string[] {
  const defects: string[] = []
  if (side.appVersion !== WORK_ITEM_START_E2E_BASELINE_VERSION) {
    defects.push(
      `${label} is ${side.appVersion}, not the ${WORK_ITEM_START_E2E_BASELINE_VERSION} baseline`
    )
  }
  if (!side.buildId) {
    defects.push(`${label} reported no effective build id`)
  }
  if (!side.candidateArtifactSha256) {
    defects.push(`${label} names no published candidate artifact`)
  }
  if (!side.provenance.trim()) {
    defects.push(`${label} did not name where its version and build came from`)
  }
  if (!side.manifestArtifact) {
    // O vínculo é por identidade embutida, não por bytes: o sha256 do instalador nunca é o
    // do executável instalado, então exigir igualdade seria um portão impossível.
    defects.push(`${label} embedded build identity does not match the candidate manifest`)
  }
  if (!side.artifactSha256) {
    defects.push(`${label} did not report the sha256 of the executable it is running`)
  }
  if (!side.commit || !side.tree) {
    defects.push(`${label} is not bound to a candidate commit and tree`)
  }
  return defects
}

/**
 * Um E2E só conta como positivo quando os DOIS lados são 1.4.203, o cliente é o Desktop
 * Windows, cada lado amarra o próprio binário, e um único writer entregou o prompt uma vez.
 */
export function workItemStartE2eDefects(evidence: WorkItemStartE2eEvidence): string[] {
  const defects = [
    ...sideDefects('server', evidence.server),
    ...sideDefects('client', evidence.client)
  ]
  if (evidence.server.appVersion !== evidence.client.appVersion) {
    defects.push(
      `server ${evidence.server.appVersion} and client ${evidence.client.appVersion} differ`
    )
  }
  if (evidence.client.platformNormalized !== 'windows') {
    defects.push(`client platform is ${evidence.client.platform}, not the Windows Desktop`)
  }
  // `buildId` sai de commit+árvore, logo é IGUAL nos dois lados do mesmo candidato — isso é
  // o esperado, não um defeito. O que precisa diferir são os binários: o executável que cada
  // lado roda e o artefato publicado de cada plataforma.
  if (
    evidence.server.artifactSha256 !== null &&
    evidence.server.artifactSha256 === evidence.client.artifactSha256
  ) {
    defects.push('one executable sha256 for a Windows client and its server; these are two hosts')
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
