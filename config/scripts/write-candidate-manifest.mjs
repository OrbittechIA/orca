import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBuildProvenanceLiteral } from './build-provenance.mjs'

const KIND_BY_EXTENSION = new Map([
  ['.exe', 'nsis'],
  ['.appimage', 'appimage'],
  ['.deb', 'deb'],
  ['.rpm', 'rpm'],
  ['.zip', 'zip'],
  ['.dmg', 'dmg']
])

const PLATFORM_BY_KIND = new Map([
  ['nsis', 'windows'],
  ['zip', 'windows'],
  ['appimage', 'linux'],
  ['deb', 'linux'],
  ['rpm', 'linux'],
  ['dmg', 'macos']
])

function archOf(name) {
  const lower = name.toLowerCase()
  if (lower.includes('arm64') || lower.includes('aarch64')) {
    return 'arm64'
  }
  if (lower.includes('ia32') || lower.includes('x86')) {
    return 'ia32'
  }
  return 'x64'
}

/**
 * O manifest do candidato, montado a partir dos artefatos que o empacotador acabou de
 * escrever. `buildId` vem da MESMA fonte embutida nos binários, para que a evidência possa
 * comparar identidade em vez de bytes — o sha256 do instalador nunca é o do executável
 * instalado.
 */
export function buildCandidateManifest({ distDir, provenanceLiteral }) {
  const provenance = JSON.parse(provenanceLiteral)
  if (!provenance) {
    throw new Error('no build provenance: refusing to write a manifest nothing can be matched to')
  }
  const artifacts = readdirSync(distDir)
    .filter((name) => KIND_BY_EXTENSION.has(name.slice(name.lastIndexOf('.')).toLowerCase()))
    .filter((name) => !name.startsWith('.'))
    .map((name) => {
      const kind = KIND_BY_EXTENSION.get(name.slice(name.lastIndexOf('.')).toLowerCase())
      const path = join(distDir, name)
      return {
        artifact: name,
        platform: PLATFORM_BY_KIND.get(kind),
        arch: archOf(name),
        kind,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        bytes: statSync(path).size
      }
    })
    .sort((a, b) => a.artifact.localeCompare(b.artifact))
  return { ...provenance, artifacts }
}

if (import.meta.filename === process.argv[1]) {
  const root = resolve(import.meta.dirname, '../..')
  const distDir = process.argv[2] ? resolve(process.argv[2]) : join(root, 'dist')
  const manifest = buildCandidateManifest({
    distDir,
    provenanceLiteral: readBuildProvenanceLiteral({ cwd: root })
  })
  const target = join(distDir, 'candidate-manifest.json')
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(target)
}
