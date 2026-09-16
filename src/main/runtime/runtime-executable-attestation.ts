import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { readBuildProvenance, type BuildProvenance } from '../../shared/build-provenance'

/**
 * O que este host atesta sobre o binário que o executa.
 *
 * Sem caminho: um cliente pareado não precisa saber onde o servidor está instalado, e
 * publicar isso vazaria layout de disco de graça. O que prova o candidato é a identidade
 * embutida mais o hash — não o local.
 */
export type RuntimeBuildAttestation = {
  sha256: string
  bytes: number
  /** Do host que responde, não de quem pergunta: a identidade embutida não as carrega. */
  platform: string
  arch: string
  buildProvenance: BuildProvenance | null
}

let cached: Promise<RuntimeBuildAttestation | null> | null = null

async function attest(): Promise<RuntimeBuildAttestation | null> {
  try {
    const { size } = await stat(process.execPath)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(process.execPath)) {
      digest.update(chunk as Buffer)
    }
    return {
      sha256: digest.digest('hex'),
      bytes: size,
      platform: process.platform,
      arch: process.arch,
      buildProvenance: readBuildProvenance()
    }
  } catch {
    return null
  }
}

/**
 * Calculado sob demanda e memorizado.
 *
 * Deliberadamente fora de `status.get`: hashear ~200 MB em todo processo que sobe seria uma
 * regressão de startup paga por todo mundo para servir só à evidência do E2E, e ler antes
 * de terminar devolveria um vazio que parece ausência.
 */
export function getRuntimeBuildAttestation(): Promise<RuntimeBuildAttestation | null> {
  cached ??= attest()
  return cached
}

export function resetRuntimeBuildAttestationForTests(): void {
  cached = null
}
