import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBuildProvenanceLiteral } from './build-provenance.mjs'

/**
 * Prova que o bundle FINAL carrega a identidade deste commit.
 *
 * A substituição acontece no carregamento do config do empacotador, longe de onde se pode
 * observá-la, e quando falha o resultado não é um erro: é um `null` embutido que só aparece
 * quando o portão da evidência recusa um candidato já publicado. Este gate lê os bytes que
 * foram empacotados e compara com o git — o VALOR no ponto de leitura, não strings soltas.
 */

/** Byte-identical to `BUILD_PROVENANCE_EMBED_SITE` in `src/shared/build-provenance.ts`. */
export const EMBED_SITE = 'orca:build-provenance:embed'

const IDENTITY_FIELDS = ['version', 'commit', 'tree', 'buildId']
const QUOTED = `(?:"([^"\\\\]*)"|'([^'\\\\]*)'|\`([^\`\\\\]*)\`)`
const SITE_PATTERN = new RegExp(
  `site\\s*:\\s*(?:"${EMBED_SITE}"|'${EMBED_SITE}'|\`${EMBED_SITE}\`)\\s*,\\s*value\\s*:\\s*`,
  'g'
)
const IDENTITY_PATTERN = new RegExp(
  `^\\{\\s*${IDENTITY_FIELDS.map((field) => `"?${field}"?\\s*:\\s*${QUOTED}\\s*`).join(',\\s*')},?\\s*\\}`
)

function quoted(match, offset) {
  return match[offset] ?? match[offset + 1] ?? match[offset + 2]
}

/**
 * Every embed site in the bundle and the value substituted right after it. `identity` is
 * `null` for `null`, an unreplaced identifier, or a malformed object; `null` never means "not
 * found" — sites are counted separately so an absent site and a null value both refuse.
 */
export function extractEmbeddedBuildProvenance(bundle) {
  const sites = []
  for (const match of bundle.matchAll(SITE_PATTERN)) {
    const after = bundle.slice(match.index + match[0].length, match.index + match[0].length + 512)
    const identity = IDENTITY_PATTERN.exec(after)
    sites.push(
      identity
        ? {
            version: quoted(identity, 1),
            commit: quoted(identity, 4),
            tree: quoted(identity, 7),
            buildId: quoted(identity, 10)
          }
        : null
    )
  }
  return sites
}

export function verifyBundledBuildProvenance({ bundlePath, expectedLiteral, bundle }) {
  if (expectedLiteral === 'null') {
    throw new Error(
      'no build provenance for this tree: refusing to certify a bundle nothing can be matched to'
    )
  }
  const expected = JSON.parse(expectedLiteral)
  bundle ??= readFileSync(bundlePath, 'utf8')
  const sites = extractEmbeddedBuildProvenance(bundle)
  if (sites.length === 0) {
    throw new Error(`${bundlePath} has no build provenance embed site; this is not an Orca bundle`)
  }
  if (sites.length > 1) {
    throw new Error(
      `${bundlePath} has ${sites.length} build provenance embed sites; an ambiguous identity certifies nothing`
    )
  }
  const embedded = sites[0]
  if (!embedded) {
    throw new Error(
      `${bundlePath} embeds no build identity at its read site (a null literal is how the packager fails silently)`
    )
  }
  const mismatched = IDENTITY_FIELDS.filter((field) => embedded[field] !== expected[field])
  if (mismatched.length > 0) {
    throw new Error(
      `${bundlePath} embeds another build's ${mismatched.join(', ')} (${mismatched.map((field) => embedded[field]).join(', ')}), not this tree's`
    )
  }
  return expected
}

if (import.meta.filename === process.argv[1]) {
  if (process.env.ORCA_BUILD_UNCERTIFIED === '1') {
    console.warn('[build-provenance] ORCA_BUILD_UNCERTIFIED=1: bundle not verified, cannot certify')
    process.exit(0)
  }
  const root = resolve(import.meta.dirname, '../..')
  const bundlePath = process.argv[2] ?? join(root, 'out', 'main', 'index.js')
  const expected = verifyBundledBuildProvenance({
    bundlePath,
    expectedLiteral: readBuildProvenanceLiteral({ cwd: root })
  })
  console.log(
    `build provenance in ${bundlePath}: ${expected.version} ${expected.commit} tree ${expected.tree} build ${expected.buildId}`
  )
}
