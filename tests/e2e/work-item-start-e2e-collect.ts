import {
  buildIdFor,
  requireManifestArtifact,
  sha256OfFile,
  type CandidateManifest,
  type CandidateManifestArtifact
} from './work-item-start-candidate-manifest'
import {
  buildWorkItemStartE2eEvidence,
  type WorkItemStartE2eEvidence
} from './work-item-start-e2e-evidence'
import { buildProvenanceMatches, type BuildProvenance } from '../../src/shared/build-provenance'

/**
 * O processo Electron REAL, lido de si mesmo.
 *
 * `appVersion`, `platform`, `arch`, `osRelease` e `execPath` existem no processo;
 * `buildProvenance` é a identidade que o empacotador substituiu no bundle. O hash do
 * `execPath` é registrado como observação, NUNCA comparado com o hash do instalador: o
 * NSIS extrai o `Orca.exe` e o AppImage monta um Electron interno, então os dois sha256
 * são diferentes por construção e compará-los seria um portão impossível.
 */
export type ClientProcessReader = () => Promise<{
  appVersion: string
  platform: string
  arch?: string
  osRelease?: string
  execPath: string
  buildProvenance: BuildProvenance | null
  /** From the client's own `runtime.buildAttestation`; absent on a build that predates it. */
  appContentSha256?: string | null
  attestationId?: string | null
}>

/** `status.get`: `appVersion`, `runtimeId`, capabilities e a proveniência aditiva. */
export type ServerStatusReader = () => Promise<{
  appVersion?: string
  runtimeId?: string
  capabilities?: readonly string[]
  buildProvenance?: BuildProvenance | null
  /** A plataforma que o host reporta de si; a identidade embutida não a carrega. */
  hostPlatform?: string
}>

/**
 * `runtime.buildAttestation`: o host hasheando o próprio executável, sob demanda.
 *
 * Fora de `status.get` de propósito — hashear ~200 MB em todo boot seria uma regressão paga
 * por todos para servir só à evidência. Sem caminho: o layout de disco do servidor não é
 * necessário para provar o candidato.
 */
export type ServerAttestationReader = () => Promise<{
  sha256?: string
  bytes?: number
  /** A plataforma do HOST que atestou; jamais a do runner que coleta. */
  platform?: string
  arch?: string
  buildProvenance?: BuildProvenance | null
  appContent?: { kind: string; sha256?: string } | null
  attestationId?: string
} | null>

export type WorkItemStartE2eCollection = {
  now: () => string
  readClientProcess: ClientProcessReader
  readServerStatus: ServerStatusReader
  readServerAttestation: ServerAttestationReader
  manifest: CandidateManifest
  /** Os nomes EXATOS dos dois artefatos do candidato que produziram estes processos. */
  artifacts: { client: string; server: string }
  outcome: WorkItemStartE2eEvidence['outcome']
  /** `ORCA_CANDIDATE_EXPECTED_COMMIT`, when the owner pinned one. */
  expectedCommit?: string
  hashFile?: (path: string | null | undefined) => string | null
}

/**
 * A entrada do manifest que este lado deve ter usado, validada contra a identidade embutida.
 *
 * O artefato é NOMEADO pelo chamador: com NSIS x64 e arm64, ou AppImage e deb publicados
 * juntos, "o primeiro da plataforma" apontaria para o binário errado. E a plataforma é
 * conferida contra o processo, não contra a identidade — o empacotador roda no host de
 * build e num build cruzado gravaria a plataforma errada.
 */
function matchedArtifact(
  manifest: CandidateManifest,
  provenance: BuildProvenance | null,
  artifactName: string,
  runtimePlatform: string,
  runtimeArch: string | undefined
): CandidateManifestArtifact | null {
  const expected: BuildProvenance = {
    version: manifest.version,
    commit: manifest.commit,
    tree: manifest.tree,
    buildId: manifest.buildId
  }
  if (!buildProvenanceMatches(provenance, expected)) {
    return null
  }
  const entry = requireManifestArtifact(manifest, artifactName)
  if (!entry) {
    return null
  }
  const platform = runtimePlatform.toLowerCase()
  const family = platform.startsWith('win')
    ? 'windows'
    : platform === 'darwin' || platform.startsWith('mac')
      ? 'macos'
      : 'linux'
  if (entry.platform !== family) {
    return null
  }
  // A arquitetura também: sem isto um NSIS x64 nomeado para um cliente arm64 passaria, e a
  // prova apontaria para um binário que aquele processo não poderia ter executado.
  return runtimeArch === undefined || entry.arch === runtimeArch ? entry : null
}

/**
 * Coleta a evidência dos dois processos em execução e a amarra ao manifest do candidato.
 *
 * O vínculo é por IDENTIDADE — versão, commit, árvore e buildId embutidos precisam ser os
 * do manifest. O sha256 do executável observado e o sha256/tamanho do artefato publicado
 * viajam juntos como dois fatos distintos: o primeiro diz o que rodou, o segundo diz o que
 * foi publicado.
 */
export async function collectWorkItemStartE2eEvidence(
  args: WorkItemStartE2eCollection
): Promise<WorkItemStartE2eEvidence> {
  const hash = args.hashFile ?? sha256OfFile
  const [client, server, attestation] = await Promise.all([
    args.readClientProcess(),
    args.readServerStatus(),
    args.readServerAttestation()
  ])

  const clientArtifact = matchedArtifact(
    args.manifest,
    client.buildProvenance,
    args.artifacts.client,
    client.platform,
    client.arch
  )
  // A atestação é a palavra do próprio host; `status.get` é só o que ele já publicava.
  const serverProvenance = attestation?.buildProvenance ?? server.buildProvenance ?? null
  const serverArtifact = matchedArtifact(
    args.manifest,
    serverProvenance,
    args.artifacts.server,
    attestation?.platform ?? server.hostPlatform ?? 'unknown',
    attestation?.arch
  )
  const clientExecSha = hash(client.execPath)
  const serverExecSha = attestation?.sha256 ?? null

  const serverAppContent =
    attestation?.appContent?.kind === 'app-asar' ? (attestation.appContent.sha256 ?? null) : null

  return buildWorkItemStartE2eEvidence({
    now: args.now(),
    candidate: {
      version: args.manifest.version,
      commit: args.manifest.commit,
      tree: args.manifest.tree,
      buildId: args.manifest.buildId,
      ...(args.expectedCommit !== undefined ? { expectedCommit: args.expectedCommit } : {})
    },
    client: {
      appVersion: client.appVersion,
      buildId: client.buildProvenance?.buildId ?? buildIdFor(clientExecSha),
      commit: client.buildProvenance?.commit ?? null,
      tree: client.buildProvenance?.tree ?? null,
      artifactPath: client.execPath,
      artifactSha256: clientExecSha,
      appContentSha256: client.appContentSha256 ?? null,
      attestationId: client.attestationId ?? null,
      candidateArtifact: clientArtifact,
      manifestArtifact: clientArtifact?.artifact ?? null,
      platform: client.platform,
      ...(client.arch !== undefined ? { arch: client.arch } : {}),
      ...(client.osRelease !== undefined ? { osRelease: client.osRelease } : {}),
      provenance: client.buildProvenance
        ? clientArtifact
          ? `embedded build identity of the running process ${client.execPath}, matching ${clientArtifact.artifact} in the candidate manifest`
          : `embedded build identity of the running process ${client.execPath} does NOT match the named candidate artifact`
        : `running process ${client.execPath} carries no embedded build identity`
    },
    server: {
      ...(server.appVersion !== undefined ? { appVersion: server.appVersion } : {}),
      buildId: serverProvenance?.buildId ?? buildIdFor(serverExecSha),
      commit: serverProvenance?.commit ?? null,
      tree: serverProvenance?.tree ?? null,
      // Sem caminho: o host atesta o binário, não revela onde ele mora.
      artifactPath: null,
      artifactSha256: serverExecSha,
      appContentSha256: serverAppContent,
      attestationId: attestation?.attestationId ?? null,
      candidateArtifact: serverArtifact,
      manifestArtifact: serverArtifact?.artifact ?? null,
      ...(server.runtimeId !== undefined ? { runtimeId: server.runtimeId } : {}),
      ...(server.capabilities ? { capabilities: server.capabilities } : {}),
      provenance: serverProvenance
        ? serverArtifact
          ? `runtime.buildAttestation embedded identity and executable sha256, matching ${serverArtifact.artifact}`
          : 'runtime.buildAttestation embedded identity does NOT match the named candidate artifact'
        : 'the host exposed no buildProvenance; this server is not bound to the candidate'
    },
    outcome: args.outcome
  })
}
