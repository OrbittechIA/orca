/**
 * A identidade do build embutida no pacote.
 *
 * Existe porque nenhuma superfície de runtime a carrega: `status.get` devolve apenas
 * `appVersion` e o status do runtime, e `ClientEnvironmentInfo` traz versão, plataforma,
 * release e arch. Sem isto, amarrar um processo em execução ao commit que o produziu só
 * poderia ser feito comparando hashes — e o sha256 do instalador NUNCA é o do executável
 * instalado (NSIS extrai; o AppImage monta e executa um Electron interno), então essa
 * comparação é um portão impossível.
 */
/**
 * Só o que o empacotador sabe com certeza sobre a FONTE.
 *
 * Plataforma e arquitetura ficam de fora de propósito: o config do empacotador roda no host
 * de build, e num `build:win` cruzado a partir do Linux gravaria `linux/x64` dentro do
 * cliente Windows. Essas duas são lidas do processo em execução, que é quem de fato sabe.
 */
import { isUnknownRecord } from './unknown-record'

export type BuildProvenance = {
  version: string
  /** SHA completo, não abreviado. */
  commit: string
  tree: string
  /** Derivado de commit+árvore: igual nos dois lados do mesmo candidato, e isso é esperado. */
  buildId: string
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseBuildProvenance(value: unknown): BuildProvenance | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (!isUnknownRecord(value)) {
    return null
  }
  const candidate = value
  if (
    !isNonEmpty(candidate.version) ||
    !isNonEmpty(candidate.commit) ||
    !isNonEmpty(candidate.tree) ||
    !isNonEmpty(candidate.buildId)
  ) {
    return null
  }
  return {
    version: candidate.version.trim(),
    commit: candidate.commit.trim(),
    tree: candidate.tree.trim(),
    buildId: candidate.buildId.trim()
  }
}

/**
 * O sentinela EXATO a que o verificador de empacotamento se amarra: o valor que vem logo
 * depois dele no bundle é o que o empacotador substituiu, não importa onde mais as mesmas
 * strings apareçam. Mantido em `config/scripts/verify-build-provenance.mjs` byte a byte.
 */
export const BUILD_PROVENANCE_EMBED_SITE = 'orca:build-provenance:embed'

type BuildProvenanceEmbed = { site: string; value: unknown }

function embeddedBuildProvenance(embed: BuildProvenanceEmbed): unknown {
  // Uma checagem real do sentinela, para que nenhum minificador o descarte como não lido.
  return embed.site === BUILD_PROVENANCE_EMBED_SITE ? embed.value : null
}

/** `null` num build de contribuidor: ausência declarada, nunca um valor de cortesia. */
export function readBuildProvenance(): BuildProvenance | null {
  // Lido de `globalThis` e não do identificador direto: o define do empacotador escreve os
  // dois, e só este resolve igual em todos os tsconfigs do repositório.
  return parseBuildProvenance(
    embeddedBuildProvenance({
      site: BUILD_PROVENANCE_EMBED_SITE,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the packager's define substitutes exactly this member read; the value is consumed as `unknown` and parsed, and `build-constants.d.ts` is not in the cli/mobile tsconfigs that also compile this module.
      value: (globalThis as { ORCA_BUILD_PROVENANCE?: unknown }).ORCA_BUILD_PROVENANCE
    })
  )
}

/** Duas identidades do mesmo candidato: compara os quatro campos, não bytes. */
export function buildProvenanceMatches(
  observed: BuildProvenance | null,
  expected: BuildProvenance
): boolean {
  return (
    observed !== null &&
    observed.version === expected.version &&
    observed.commit === expected.commit &&
    observed.tree === expected.tree &&
    observed.buildId === expected.buildId
  )
}
