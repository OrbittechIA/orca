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

/** Working-tree entries that make the commit an unreliable name for what was built. Ignored
 *  paths (`dist`, `out`, `node_modules`) never appear here; EVERYTHING else does — including
 *  a file shaped like electron-vite's transient config bundle. That bundle is kept out of this
 *  observation by timing (see `readBuildProvenanceLiteralForConfigLoad`), never by name. */
export function dirtyBuildInputs(statusPorcelain) {
  return statusPorcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/**
 * electron-vite bundles its config into `electron.vite.config.<timestamp>.mjs` in the working
 * directory while the config loads — which is exactly when the config asks for provenance —
 * and deletes it afterwards. Whitelisting that name would let any file hide under it, so the
 * identity is read BEFORE electron-vite starts, by the build wrapper, and handed to the config
 * through this variable. The config does not trust it blindly: it must still name the commit
 * and tree git reports at load time.
 */
export const ELECTRON_VITE_BUILD_PROVENANCE_ENV = 'ORCA_ELECTRON_VITE_BUILD_PROVENANCE'

export function provenanceEnvironmentForElectronVite({
  cwd,
  env = process.env,
  run = execFileSync,
  warn
} = {}) {
  return {
    ...env,
    [ELECTRON_VITE_BUILD_PROVENANCE_ENV]: readBuildProvenanceLiteral({
      cwd,
      env,
      run,
      ...(warn ? { warn } : {})
    })
  }
}

const IDENTITY_FIELDS = ['version', 'commit', 'tree', 'buildId']

/** The literal the config embeds. With the wrapper's handoff present it is validated against
 *  the repository and used; without it (a direct `electron-vite` invocation) the strict read
 *  runs here, where the transient bundle makes the tree dirty and the answer `null`. */
export function readBuildProvenanceLiteralForConfigLoad({
  cwd = process.cwd(),
  env = process.env,
  run = execFileSync,
  warn = (message) => console.warn(`[build-provenance] ${message}`)
} = {}) {
  const handed = env[ELECTRON_VITE_BUILD_PROVENANCE_ENV]
  if (handed === undefined) {
    return readBuildProvenanceLiteral({ cwd, env, run, warn })
  }
  if (handed === 'null') {
    return 'null'
  }
  let identity
  try {
    identity = JSON.parse(handed)
  } catch {
    throw new BuildProvenanceError(`${ELECTRON_VITE_BUILD_PROVENANCE_ENV} is not JSON`)
  }
  if (
    !identity ||
    typeof identity !== 'object' ||
    IDENTITY_FIELDS.some((field) => typeof identity[field] !== 'string' || !identity[field]) ||
    Object.keys(identity).length !== IDENTITY_FIELDS.length
  ) {
    throw new BuildProvenanceError(`${ELECTRON_VITE_BUILD_PROVENANCE_ENV} is not a build identity`)
  }
  const git = (args) => String(run('git', args, { cwd, encoding: 'utf8' })).trim()
  let commit
  let tree
  try {
    commit = git(['rev-parse', 'HEAD'])
    tree = git(['rev-parse', 'HEAD^{tree}'])
  } catch {
    throw new BuildProvenanceError(
      `${ELECTRON_VITE_BUILD_PROVENANCE_ENV} was handed over but no git repository can confirm it`
    )
  }
  if (identity.commit !== commit || identity.tree !== tree) {
    throw new BuildProvenanceError(
      `${ELECTRON_VITE_BUILD_PROVENANCE_ENV} names ${identity.commit}/${identity.tree}, the repository is at ${commit}/${tree}`
    )
  }
  return JSON.stringify({
    version: identity.version,
    commit: identity.commit,
    tree: identity.tree,
    buildId: identity.buildId
  })
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
