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
  const candidate = value as Partial<Record<keyof BuildProvenance, unknown>>
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

/** `null` num build de contribuidor: ausência declarada, nunca um valor de cortesia. */
export function readBuildProvenance(): BuildProvenance | null {
  // Lido de `globalThis` e não do identificador direto: o define do empacotador escreve os
  // dois, e só este resolve igual em todos os tsconfigs do repositório.
  return parseBuildProvenance(
    (globalThis as { ORCA_BUILD_PROVENANCE?: unknown }).ORCA_BUILD_PROVENANCE
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
