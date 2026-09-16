import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBuildProvenanceLiteral } from './build-provenance.mjs'

/**
 * Prova que o bundle FINAL carrega a identidade deste commit.
 *
 * A substituição acontece no carregamento do config do empacotador, longe de onde se pode
 * observá-la, e quando falha o resultado não é um erro: é um `null` embutido que só aparece
 * quando o portão da evidência recusa um candidato já publicado. Este gate lê os bytes que
 * foram empacotados e compara com o git.
 */
export function verifyBundledBuildProvenance({ bundlePath, expectedLiteral }) {
  if (expectedLiteral === 'null') {
    throw new Error(
      'no build provenance for this tree: refusing to certify a bundle nothing can be matched to'
    )
  }
  const expected = JSON.parse(expectedLiteral)
  const bundle = readFileSync(bundlePath, 'utf8')
  const missing = ['commit', 'tree', 'buildId', 'version'].filter(
    (field) => !bundle.includes(expected[field])
  )
  if (missing.length > 0) {
    throw new Error(
      `${bundlePath} does not carry this build's ${missing.join(', ')}; the packager substituted something else (a null literal is how this fails silently)`
    )
  }
  return expected
}

if (import.meta.filename === process.argv[1]) {
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
