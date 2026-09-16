import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A identidade do build, lida do git no empacotamento.
 *
 * `buildId` sai de commit+árvore e não de um hash de artefato: o sha256 do instalador
 * nunca é o do executável instalado, então um id derivado do binário não serviria para
 * casar as duas pontas.
 *
 * Fail-closed: a identidade só é declarada quando os inputs do build SÃO o commit. Uma
 * árvore suja embutiria a identidade de um commit que não foi o que se empacotou, e um
 * override de ambiente que contradiz o repositório seria uma identidade inventada. Nos dois
 * casos a resposta é `null`, que nenhum portão de certificação aceita.
 */
export class BuildProvenanceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BuildProvenanceError'
  }
}

/** electron-vite bundles its config into the working directory while loading it — which is
 *  exactly when this module runs — and removes the file afterwards. It is derived from the
 *  tracked config, so it is not an input; it is also gitignored, this is the belt to that brace. */
const TRANSIENT_CONFIG_BUNDLE = /^\?\? electron\.vite\.config\.\d+\.mjs$/

/** Working-tree entries that make the commit an unreliable name for what was built. Ignored
 *  paths (`dist`, `out`, `node_modules`) never appear here; anything else does. */
export function dirtyBuildInputs(statusPorcelain) {
  return statusPorcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !TRANSIENT_CONFIG_BUNDLE.test(line))
}

export function readBuildProvenanceLiteral({
  // Why process.cwd() and not `import.meta.dirname`: electron-vite loads and BUNDLES the
  // config into a temp directory, so this module's own path stops pointing at the repo and
  // `git` runs somewhere that is not one. That silently produced `null` and shipped a
  // package no candidate gate could match. Callers that know their root pass it explicitly.
  cwd = process.cwd(),
  env = process.env,
  run = execFileSync,
  warn = (message) => console.warn(`[build-provenance] ${message}`)
} = {}) {
  const git = (args) => String(run('git', args, { cwd, encoding: 'utf8' })).trim()
  let commit
  let tree
  let status
  try {
    commit = git(['rev-parse', 'HEAD'])
    tree = git(['rev-parse', 'HEAD^{tree}'])
    status = git(['status', '--porcelain', '--untracked-files=all'])
  } catch {
    // Sem git (tarball de origem) não há proveniência a declarar; `null` é a resposta honesta.
    // Um override sem repositório para validá-lo é uma identidade que ninguém confere.
    if (env.ORCA_BUILD_COMMIT || env.ORCA_BUILD_TREE) {
      throw new BuildProvenanceError(
        'ORCA_BUILD_COMMIT/ORCA_BUILD_TREE were given but no git repository can confirm them'
      )
    }
    return 'null'
  }
  for (const [name, expected, actual] of [
    ['ORCA_BUILD_COMMIT', env.ORCA_BUILD_COMMIT?.trim(), commit],
    ['ORCA_BUILD_TREE', env.ORCA_BUILD_TREE?.trim(), tree]
  ]) {
    // O override é uma ASSERÇÃO do que o CI espera empacotar, nunca uma fonte: só passa
    // quando o repositório concorda.
    if (expected && expected !== actual) {
      throw new BuildProvenanceError(
        `${name}=${expected} does not match the repository (${actual})`
      )
    }
  }
  const dirty = dirtyBuildInputs(status)
  if (dirty.length > 0) {
    warn(
      `no build provenance: ${dirty.length} working-tree change(s) mean HEAD is not what is being built (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''})`
    )
    return 'null'
  }
  const { version } = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
  // Sem plataforma/arch: este script roda no host de BUILD, e num `build:win` cruzado a
  // partir do Linux gravaria `linux/x64` dentro do cliente Windows. Quem sabe disso é o
  // processo em execução.
  const buildId = createHash('sha256').update(`${commit}:${tree}`).digest('hex').slice(0, 12)
  return JSON.stringify({ version, commit, tree, buildId })
}
