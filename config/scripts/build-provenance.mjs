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
 */
export function readBuildProvenanceLiteral({
  // Why process.cwd() and not `import.meta.dirname`: electron-vite loads and BUNDLES the
  // config into a temp directory, so this module's own path stops pointing at the repo and
  // `git` runs somewhere that is not one. That silently produced `null` and shipped a
  // package no candidate gate could match. Callers that know their root pass it explicitly.
  cwd = process.cwd(),
  env = process.env,
  run = execFileSync
} = {}) {
  const git = (args) => String(run('git', args, { cwd, encoding: 'utf8' })).trim()
  let commit
  let tree
  try {
    commit = env.ORCA_BUILD_COMMIT?.trim() || git(['rev-parse', 'HEAD'])
    tree = env.ORCA_BUILD_TREE?.trim() || git(['rev-parse', 'HEAD^{tree}'])
  } catch {
    // Sem git (tarball de origem) não há proveniência a declarar; `null` é a resposta honesta.
    return 'null'
  }
  const { version } = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
  // Sem plataforma/arch: este script roda no host de BUILD, e num `build:win` cruzado a
  // partir do Linux gravaria `linux/x64` dentro do cliente Windows. Quem sabe disso é o
  // processo em execução.
  const buildId = createHash('sha256').update(`${commit}:${tree}`).digest('hex').slice(0, 12)
  return JSON.stringify({ version, commit, tree, buildId })
}
