import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  // rpm names x64 `x86_64`, which a bare `x86` match would misread as ia32.
  if (/x86_64|amd64|x64/.test(lower)) {
    return 'x64'
  }
  if (/ia32|i[3-6]86|x86/.test(lower)) {
    return 'ia32'
  }
  return 'x64'
}

const PLATFORM_BY_ELECTRON = new Map([
  ['win32', 'windows'],
  ['linux', 'linux'],
  ['darwin', 'macos']
])

/** Sidecar afterPack writes next to the artifacts: the packaged `app.asar` hash per platform and
 *  arch. Installers wrap it, so it cannot be recovered from the artifact bytes afterwards. */
export function appContentSidecarName(platform, arch) {
  return `app-content.${platform}-${arch}.json`
}

export function writeAppContentSidecar({ distDir, electronPlatform, arch, asarPath }) {
  const platform = PLATFORM_BY_ELECTRON.get(electronPlatform)
  if (!platform) {
    throw new Error(`unknown packaging platform ${electronPlatform}`)
  }
  const bytes = readFileSync(asarPath)
  const record = {
    platform,
    arch,
    appContentSha256: createHash('sha256').update(bytes).digest('hex'),
    appContentBytes: bytes.length
  }
  const target = join(distDir, appContentSidecarName(platform, arch))
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
  return target
}

function readAppContent(distDir, platform, arch) {
  const path = join(distDir, appContentSidecarName(platform, arch))
  if (!existsSync(path)) {
    return null
  }
  const record = JSON.parse(readFileSync(path, 'utf8'))
  return /^[0-9a-f]{64}$/.test(record?.appContentSha256 ?? '') ? record : null
}

/**
 * O manifest do candidato, montado a partir dos artefatos que o empacotador acabou de
 * escrever. `buildId` vem da MESMA fonte embutida nos binários, para que a evidência possa
 * comparar identidade em vez de bytes — o sha256 do instalador nunca é o do executável
 * instalado.
 */
export function buildCandidateManifest({ distDir, provenanceLiteral, requireAppContent = true }) {
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
      const platform = PLATFORM_BY_KIND.get(kind)
      const arch = archOf(name)
      const appContent = readAppContent(distDir, platform, arch)
      // Fail closed: without it the evidence could bind only the Electron executable, which every
      // Orca build on the same Electron version shares.
      if (!appContent && requireAppContent) {
        throw new Error(
          `no ${appContentSidecarName(platform, arch)} for ${name}: refusing a manifest that cannot bind app content`
        )
      }
      return {
        artifact: name,
        platform,
        arch,
        kind,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        bytes: statSync(path).size,
        ...(appContent
          ? {
              appContentSha256: appContent.appContentSha256,
              appContentBytes: appContent.appContentBytes
            }
          : {})
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
