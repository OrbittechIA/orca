import {
  materialPathAbsent as absent,
  absentLocalMaterialPath as absentPathWithoutSymlinks
} from './runtime-worktree-material-admission'
import { createHash } from 'node:crypto'
import { lstat, realpath, readdir, readFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { devNull } from 'node:os'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv, isWslPath } from '../git/runner'
import { deriveGitRemoteIdentity } from '../../shared/git-remote-identity'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type {
  MaterialCode,
  MaterialManifest,
  MaterialGitObservation
} from '../../shared/worktree/material-types'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'
export type { MaterialGitObservation } from '../../shared/worktree/material-types'

const CAS_CONFLICT: MaterialCode = 'E_MATERIAL_CAS_CONFLICT'
const UNSUPPORTED: MaterialCode = 'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED'
const ADMIN_CONFLICT: MaterialCode = 'E_MATERIAL_ADMIN_CONFLICT'
const INVENTORY_UNVERIFIABLE: MaterialCode = 'E_MATERIAL_INVENTORY_UNVERIFIABLE'
const HISTORY_UNVERIFIABLE: MaterialCode = 'E_MATERIAL_HISTORICAL_ADMIN_UNVERIFIABLE'
class MaterialGitRefusal extends Error {
  constructor(readonly code: MaterialCode) {
    super(code)
  }
}
function requireGit(condition: unknown, code: MaterialCode): asserts condition {
  if (!condition) {
    throw new MaterialGitRefusal(code)
  }
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function runMaterialGit(repoPath: string, args: string[], timeout = 10_000) {
  const result = await gitExecFileAsync(args, {
    cwd: repoPath,
    timeout,
    maxBuffer: 20_000 * (4096 + 128),
    env: { ...gitOptionalLocksDisabledEnv(), GIT_ATTR_NOSYSTEM: '1' }
  })
  return result.stdout.trim()
}
async function readAdminFile(filename: string, limit = 8192): Promise<Buffer> {
  const stat = await lstat(filename)
  requireGit(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, HISTORY_UNVERIFIABLE)
  const bytes = await readFile(filename)
  requireGit(bytes.length <= limit, HISTORY_UNVERIFIABLE)
  return bytes
}
const adminNames = ['HEAD', 'commondir', 'gitdir', 'index']
const readAdminEvidence = (admin: string) =>
  Promise.all(adminNames.map((name) => readAdminFile(path.join(admin, name), 16 * 1024 * 1024)))
async function historicalAdminProof(repoPath: string, manifest: MaterialManifest) {
  const run = (args: string[]) => runMaterialGit(repoPath, args)
  const common = path.resolve(repoPath, await run(['rev-parse', '--git-common-dir']))
  const root = path.join(common, 'worktrees')
  requireGit(
    (await realpath(common)) === common && (await realpath(root)) === root,
    INVENTORY_UNVERIFIABLE
  )
  const entries = await readdir(root, { withFileTypes: true })
  requireGit(
    entries.length <= 4096 && !entries.some((entry) => entry.isSymbolicLink()),
    INVENTORY_UNVERIFIABLE
  )
  const owners: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const admin = path.join(root, entry.name)
      const back = (await readAdminFile(path.join(admin, 'gitdir'))).toString().trim()
      if (path.resolve(admin, back) === path.join(manifest.path, '.git')) {
        owners.push(admin)
      }
    }
  }
  requireGit(owners.length === 1, ADMIN_CONFLICT)
  const admin = owners[0]
  const [head, commonFile, , index] = await readAdminEvidence(admin)
  requireGit(
    head.toString().trim() === `ref: refs/heads/${manifest.branch}` &&
      path.resolve(admin, commonFile.toString().trim()) === common,
    ADMIN_CONFLICT
  )
  const locks = [
    path.join(admin, 'locked'),
    path.join(admin, 'index.lock'),
    path.join(admin, 'HEAD.lock'),
    path.join(common, 'packed-refs.lock'),
    path.join(common, 'refs', 'heads', `${manifest.branch}.lock`)
  ]
  requireGit((await Promise.all(locks.map(absent))).every(Boolean), ADMIN_CONFLICT)
  const prefix = [`--git-dir=${admin}`, `--work-tree=${manifest.path}`]
  const info = path.join(common, 'info')
  if (!(await absent(info))) {
    requireGit(!(await lstat(info)).isSymbolicLink(), INVENTORY_UNVERIFIABLE)
    const attributes = path.join(info, 'attributes')
    requireGit(
      (await absent(attributes)) || (await readAdminFile(attributes)).length === 0,
      UNSUPPORTED
    )
  }
  // Git 2.25 treats fsmonitor=false as a hook pathname, so refuse any nonempty setting.
  const config = await run([...prefix, 'config', '--list'])
  const unsafe =
    /^(core\.fsmonitor|filter\..*\.(smudge|process)|extensions\.partialclone|remote\..*\.promisor)=.+/
  requireGit(!config.split('\n').some((line) => unsafe.test(line)), UNSUPPORTED)
  requireGit(
    index.length >= 12 &&
      [2, 3].includes(index.readUInt32BE(4)) &&
      !index.includes(Buffer.from('link')),
    UNSUPPORTED
  )
  const staged = await run([...prefix, 'ls-files', '--stage', '-z'])
  const entriesFromIndex = staged
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)$/.exec(line)
      requireGit(
        match &&
          Buffer.byteLength(match[3]) <= 4096 &&
          !match[3]
            .split('/')
            .some((part) => !part || part === '..' || part.toLowerCase() === '.git'),
        UNSUPPORTED
      )
      return `${match[1]} blob ${match[2]}\t${match[3]}`
    })
  const names = entriesFromIndex.map((entry) => entry.slice(entry.indexOf('\t') + 1).toLowerCase())
  requireGit(!names.some((name) => path.posix.basename(name) === '.gitattributes'), UNSUPPORTED)
  requireGit(
    new Set(names).size === names.length &&
      !names.some((name) =>
        [...name].some((char) => char.charCodeAt(0) < 32 || char === '\\' || char === ':')
      ),
    ADMIN_CONFLICT
  )
  const flags = await run([...prefix, 'ls-files', '-v', '-z'])
  requireGit(
    flags
      .split('\0')
      .filter(Boolean)
      .every((line) => line.startsWith('H ')),
    ADMIN_CONFLICT
  )
  const tree = await run([...prefix, 'ls-tree', '-r', '-z', manifest.head])
  requireGit(
    entriesFromIndex.join('\0') + (entriesFromIndex.length ? '\0' : '') === tree,
    ADMIN_CONFLICT
  )
  requireGit(entriesFromIndex.length <= 20_000, INVENTORY_UNVERIFIABLE)
  const indexDigest = sha256(index)
  const adminLinks = [admin, head.toString(), commonFile.toString()]
  return {
    admin,
    indexDigest,
    // Ordered admin evidence: locator, HEAD, common-dir link, index digest, config digest.
    digest: hashCanonical([...adminLinks, indexDigest, hashCanonical(config)])
  }
}

/** Proves Git ingredients only; this is never process absence or restoration authority. */
export async function inspectMaterialGit(
  repoPath: string,
  manifest: MaterialManifest
): Promise<MaterialGitObservation> {
  let digest: string | null = null
  try {
    requireGit(
      ![
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_COMMON_DIR',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_REPLACE_REF_BASE'
      ].some((key) => process.env[key]),
      INVENTORY_UNVERIFIABLE
    )
    requireGit(!isWslPath(repoPath) && !isWslPath(manifest.path), 'E_MATERIAL_HOST_UNSUPPORTED')
    const run = (args: string[]) => runMaterialGit(repoPath, args)
    requireGit(
      (await realpath(repoPath)) === path.resolve(repoPath) &&
        (await absentPathWithoutSymlinks(manifest.path)),
      'E_MATERIAL_PATH_CONFLICT'
    )
    const source = deriveGitRemoteIdentity(await run(['remote', '-v']))?.canonicalKey
    requireGit(source === manifest.canonicalSource, 'E_MATERIAL_SOURCE_CONFLICT')
    await run(['check-ref-format', `refs/heads/${manifest.branch}`])
    const head = await run(['rev-parse', '--verify', `refs/heads/${manifest.branch}^{commit}`])
    const tree = await run(['rev-parse', '--verify', `${head}^{tree}`])
    requireGit(head === manifest.head && tree === manifest.tree, 'E_MATERIAL_REF_CONFLICT')
    const inventory = parseWorktreeList(await run(['worktree', 'list', '--porcelain']))
    // Git 2.25 lacks -z; unusual quoted locators are not decoded by guessing.
    requireGit(
      inventory.length &&
        inventory.every(
          (row) =>
            path.isAbsolute(row.path) &&
            !row.path.startsWith('"') &&
            /^[a-f0-9]{40}$/.test(row.head)
        ),
      INVENTORY_UNVERIFIABLE
    )
    digest = hashCanonical({
      source,
      inventory: inventory.map((row) => [row.path, row.branch, row.locked, row.isMainWorktree]),
      head,
      tree
    })
    const samePath = inventory.filter((row) => row.path === manifest.path)
    requireGit(
      samePath.length <= 1 &&
        !inventory.some(
          (row) => row.branch === `refs/heads/${manifest.branch}` && row.path !== manifest.path
        ),
      ADMIN_CONFLICT
    )
    const old = samePath[0]
    requireGit(old, HISTORY_UNVERIFIABLE)
    requireGit(
      !old.locked &&
        !old.isMainWorktree &&
        old.branch === `refs/heads/${manifest.branch}` &&
        old.head === head,
      ADMIN_CONFLICT
    )
    const proof = await historicalAdminProof(repoPath, manifest)
    return {
      code: 'E_MATERIAL_CENSUS_UNVERIFIABLE',
      digest: hashCanonical({ inventory: digest, admin: proof.digest }),
      adminDigest: proof.digest,
      admin: proof.admin,
      indexDigest: proof.indexDigest,
      complete: true,
      route: 'checkout-index'
    }
  } catch (error) {
    const code = error instanceof MaterialGitRefusal ? error.code : INVENTORY_UNVERIFIABLE
    return { code, digest, complete: digest !== null && code === ADMIN_CONFLICT }
  }
}

/** The caller holds admission and has durably claimed the exact target before entering. */
export async function restoreMaterialGit(
  repoPath: string,
  manifest: MaterialManifest,
  expected: MaterialGitObservation,
  markEffectPossible: () => void,
  assertCurrent: () => void | Promise<void>
): Promise<void> {
  const fresh = await inspectMaterialGit(repoPath, manifest)
  requireGit(
    fresh.admin &&
      fresh.indexDigest &&
      fresh.route === 'checkout-index' &&
      fresh.digest === expected.digest &&
      fresh.adminDigest === expected.adminDigest,
    CAS_CONFLICT
  )
  const admin = fresh.admin
  const evidence = await readAdminEvidence(admin)
  requireGit(
    sha256(evidence[3]) === fresh.indexDigest &&
      evidence[0].toString().trim() === `ref: refs/heads/${manifest.branch}`,
    CAS_CONFLICT
  )
  await assertCurrent()
  markEffectPossible()
  await mkdir(manifest.path, { mode: 0o700 })
  const link = await open(path.join(manifest.path, '.git'), 'wx', 0o600)
  try {
    await link.writeFile(`gitdir: ${admin}\n`)
    await link.sync()
  } finally {
    await link.close()
  }
  await assertCurrent()
  await runMaterialGit(
    repoPath,
    [
      `--git-dir=${admin}`,
      `--work-tree=${manifest.path}`,
      '-c',
      `core.attributesFile=${devNull}`,
      '-c',
      'core.autocrlf=false',
      'checkout-index',
      '--all'
    ],
    30_000
  )
  const after = await readAdminEvidence(admin)
  const head = await runMaterialGit(repoPath, [
    'rev-parse',
    '--verify',
    `refs/heads/${manifest.branch}^{commit}`
  ])
  requireGit(
    after.every((bytes, index) => bytes.equals(evidence[index])) && head === manifest.head,
    CAS_CONFLICT
  )
  await assertCurrent()
}
