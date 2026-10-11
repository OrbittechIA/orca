import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'

/**
 * O manifest do candidato: a única proveniência verificável que amarra um processo em
 * execução ao commit que o produziu.
 *
 * Nem `status.get` nem `ClientEnvironmentInfo` carregam build, commit ou árvore — foi
 * conferido nas duas superfícies —, então a prova não pode sair delas. E o vínculo NÃO é
 * por bytes: o sha256 do instalador nunca é o do executável instalado (o NSIS extrai o
 * `Orca.exe`; o AppImage monta e roda um Electron interno). O que casa é a identidade de
 * build embutida no pacote; os hashes viajam junto como fatos separados.
 */
export type CandidateArtifactKind = 'nsis' | 'appimage' | 'deb' | 'rpm' | 'zip' | 'dmg'

export type CandidateManifestArtifact = {
  /** Nome publicado, como saiu do empacotador. Identifica a entrada sem ambiguidade. */
  artifact: string
  platform: 'windows' | 'linux' | 'macos'
  arch: string
  kind: CandidateArtifactKind
  sha256: string
  bytes: number
  /** `app.asar` hash recorded at packaging; absent in manifests written before it existed. */
  appContentSha256?: string
  appContentBytes?: number
}

export type CandidateManifest = {
  version: string
  commit: string
  tree: string
  /** Mesmo `buildId` que o empacotador embutiu: deriva de commit+árvore, e é comparado. */
  buildId: string
  artifacts: readonly CandidateManifestArtifact[]
}

export function sha256OfFile(filePath: string | null | undefined): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null
  }
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function bytesOfFile(filePath: string | null | undefined): number | null {
  if (!filePath || !existsSync(filePath)) {
    return null
  }
  return statSync(filePath).size
}

/** Só para um lado que não declarou build id; deriva do binário observado. */
export function buildIdFor(sha256: string | null): string | null {
  return sha256 ? sha256.slice(0, 12) : null
}

export function readCandidateManifest(filePath: string): CandidateManifest {
  const manifest: CandidateManifest = JSON.parse(readFileSync(filePath, 'utf8'))
  return manifest
}

/**
 * O manifest é OBRIGATÓRIO para o E2E pareado contar como prova: sem ele nenhum lado pode
 * ser amarrado a um artefato publicado, e um "passou" sem vínculo certificaria qualquer
 * binário que estivesse rodando. Lança, em vez de devolver `null`, para que a ausência seja
 * uma falha do teste e nunca um caminho que passa.
 */
/** Optional immutable pin: the owner names the exact commit to certify without editing code. */
export function candidateExpectedCommit(
  env: Record<string, string | undefined>
): string | undefined {
  const pinned = env.ORCA_CANDIDATE_EXPECTED_COMMIT?.trim()
  if (!pinned) {
    return undefined
  }
  if (!/^[0-9a-f]{40}$/.test(pinned)) {
    throw new Error(
      `ORCA_CANDIDATE_EXPECTED_COMMIT must be a full 40-character lowercase sha, got ${pinned}`
    )
  }
  return pinned
}

export function requireCandidateManifestPath(env: Record<string, string | undefined>): string {
  const manifestPath = env.ORCA_CANDIDATE_MANIFEST?.trim()
  if (!manifestPath) {
    throw new Error(
      'ORCA_CANDIDATE_MANIFEST is required: a paired Work Item Start run without a candidate manifest cannot count as a pass'
    )
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`ORCA_CANDIDATE_MANIFEST names a file that does not exist: ${manifestPath}`)
  }
  return manifestPath
}

/**
 * A entrada EXATA que este lado deve ter usado, nomeada pelo chamador.
 *
 * Escolher "a primeira da plataforma" é subespecificado assim que o candidato publica
 * NSIS x64 e arm64, ou AppImage e deb lado a lado — e uma prova que aponta para o artefato
 * errado não é prova.
 */
export function requireManifestArtifact(
  manifest: CandidateManifest,
  artifactName: string
): CandidateManifestArtifact | null {
  return manifest.artifacts.find((entry) => entry.artifact === artifactName) ?? null
}
