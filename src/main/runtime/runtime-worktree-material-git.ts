import { createHash } from 'node:crypto'
import { lstat, realpath, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv, isWslPath } from '../git/runner'
import { deriveGitRemoteIdentity } from '../../shared/git-remote-identity'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { MaterialCode, MaterialManifest } from '../../shared/worktree/material-types'
import { hashCanonical } from './rpc/orchestration-mutation-receipt'

export type MaterialGitObservation = {
  code: MaterialCode
  digest: string | null
  complete: boolean
  route?: 'checkout-index'
  adminDigest?: string
}

async function absentPathWithoutSymlinks(target: string): Promise<boolean> {
  if (!path.isAbsolute(target) || path.normalize(target) !== target) return false
  let cursor = target
  let targetAbsent = false
  while (true) {
    try {
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink() || cursor === target || !stat.isDirectory()) return false
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      if (cursor === target) targetAbsent = true
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return targetAbsent
    cursor = parent
  }
}

async function regularFile(filename: string, limit = 8192): Promise<Buffer> {
  const stat = await lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('admin_unverifiable')
  const bytes = await readFile(filename)
  if (bytes.length > limit) throw new Error('admin_unverifiable')
  return bytes
}

async function absent(filename: string): Promise<boolean> {
  try {
    await lstat(filename)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}

async function historicalAdminProof(
  repoPath: string,
  manifest: MaterialManifest,
  run: (args: string[]) => Promise<string>
): Promise<{ digest: string; transform: boolean } | null> {
  try {
    const common = path.resolve(repoPath, await run(['rev-parse', '--git-common-dir']))
    if ((await realpath(common)) !== common) return null
    const root = path.join(common, 'worktrees')
    if ((await realpath(root)) !== root) return null
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length > 4096 || entries.some((entry) => entry.isSymbolicLink())) return null
    const owners: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const admin = path.join(root, entry.name)
      const back = (await regularFile(path.join(admin, 'gitdir'))).toString().trim()
      if (path.resolve(admin, back) === path.join(manifest.path, '.git')) owners.push(admin)
    }
    if (owners.length !== 1) return null
    const admin = owners[0]
    const head = await regularFile(path.join(admin, 'HEAD'))
    const commonFile = await regularFile(path.join(admin, 'commondir'))
    if (
      head.toString().trim() !== `ref: refs/heads/${manifest.branch}` ||
      path.resolve(admin, commonFile.toString().trim()) !== common
    )
      return null
    for (const lock of [
      path.join(admin, 'locked'),
      path.join(admin, 'index.lock'),
      path.join(admin, 'HEAD.lock'),
      path.join(common, 'packed-refs.lock'),
      path.join(common, 'refs', 'heads', `${manifest.branch}.lock`)
    ]) {
      if (!(await absent(lock))) return null
    }
    const prefix = [`--git-dir=${admin}`, `--work-tree=${manifest.path}`]
    // Git 2.25 treats fsmonitor=false as a hook pathname, so refuse any nonempty setting.
    const config = await run([...prefix, 'config', '--list'])
    if (
      config
        .split('\n')
        .some((line) =>
          /^(core\.fsmonitor|filter\..*\.(smudge|process)|extensions\.partialclone|remote\..*\.promisor)=.+/.test(
            line
          )
        )
    ) {
      return { digest: hashCanonical({ transform: true }), transform: true }
    }
    const index = await regularFile(path.join(admin, 'index'), 16 * 1024 * 1024)
    const staged = await run([...prefix, 'ls-files', '--stage', '-z'])
    const entriesFromIndex = staged
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([^\0]+)$/.exec(line)
        if (
          !match ||
          match[3]
            .split('/')
            .some((part) => !part || part === '..' || part.toLowerCase() === '.git')
        )
          throw new Error('index_unsupported')
        return `${match[1]} blob ${match[2]}\t${match[3]}`
      })
    const names = entriesFromIndex.map((entry) =>
      entry.slice(entry.indexOf('\t') + 1).toLowerCase()
    )
    if (new Set(names).size !== names.length || names.some((name) => /[\\:\x00-\x1f]/.test(name)))
      return null
    const flags = await run([...prefix, 'ls-files', '-v', '-z'])
    if (
      flags
        .split('\0')
        .filter(Boolean)
        .some((line) => !line.startsWith('H '))
    )
      return null
    const tree = await run([...prefix, 'ls-tree', '-r', '-z', manifest.head])
    if (
      entriesFromIndex.join('\0') + (entriesFromIndex.length ? '\0' : '') !== tree ||
      entriesFromIndex.length > 20_000
    )
      return null
    return {
      digest: hashCanonical({
        admin,
        head: head.toString(),
        common: commonFile.toString(),
        index: createHash('sha256').update(index).digest('hex'),
        config: hashCanonical(config)
      }),
      transform: false
    }
  } catch {
    return null
  }
}

/** Proves Git ingredients only; this is never process absence or restoration authority. */
export async function inspectMaterialGit(
  repoPath: string,
  manifest: MaterialManifest
): Promise<MaterialGitObservation> {
  if (
    [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_REPLACE_REF_BASE'
    ].some((key) => process.env[key])
  ) {
    return { code: 'E_MATERIAL_INVENTORY_UNVERIFIABLE', digest: null, complete: false }
  }
  if (isWslPath(repoPath) || isWslPath(manifest.path)) {
    return { code: 'E_MATERIAL_HOST_UNSUPPORTED', digest: null, complete: false }
  }
  const run = async (args: string[]): Promise<string> =>
    (
      await gitExecFileAsync(args, {
        cwd: repoPath,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: gitOptionalLocksDisabledEnv()
      })
    ).stdout.trim()
  try {
    if (
      (await realpath(repoPath)) !== path.resolve(repoPath) ||
      !(await absentPathWithoutSymlinks(manifest.path))
    ) {
      return { code: 'E_MATERIAL_PATH_CONFLICT', digest: null, complete: false }
    }
    const source = deriveGitRemoteIdentity(await run(['remote', '-v']))?.canonicalKey
    if (source !== manifest.canonicalSource)
      return { code: 'E_MATERIAL_SOURCE_CONFLICT', digest: null, complete: false }
    await run(['check-ref-format', `refs/heads/${manifest.branch}`])
    const head = await run(['rev-parse', '--verify', `refs/heads/${manifest.branch}^{commit}`])
    const tree = await run(['rev-parse', '--verify', `${head}^{tree}`])
    if (head !== manifest.head || tree !== manifest.tree)
      return { code: 'E_MATERIAL_REF_CONFLICT', digest: null, complete: false }
    const raw = await run(['worktree', 'list', '--porcelain'])
    const inventory = parseWorktreeList(raw)
    // Git 2.25 lacks -z; reject unusual quoted locators instead of treating a decoded guess as proof.
    if (
      !inventory.length ||
      inventory.some(
        (row) =>
          !path.isAbsolute(row.path) || row.path.startsWith('"') || !/^[a-f0-9]{40}$/.test(row.head)
      )
    ) {
      return { code: 'E_MATERIAL_INVENTORY_UNVERIFIABLE', digest: null, complete: false }
    }
    const digest = hashCanonical({ source, inventory, head, tree })
    const samePath = inventory.filter((row) => row.path === manifest.path)
    if (
      samePath.length > 1 ||
      inventory.some(
        (row) => row.branch === `refs/heads/${manifest.branch}` && row.path !== manifest.path
      )
    ) {
      return { code: 'E_MATERIAL_ADMIN_CONFLICT', digest, complete: true }
    }
    const old = samePath[0]
    if (
      old &&
      (old.locked ||
        old.isMainWorktree ||
        old.branch !== `refs/heads/${manifest.branch}` ||
        old.head !== head)
    ) {
      return { code: 'E_MATERIAL_ADMIN_CONFLICT', digest, complete: true }
    }
    if (!old) return { code: 'E_MATERIAL_HISTORICAL_ADMIN_UNVERIFIABLE', digest, complete: true }
    const proof = await historicalAdminProof(repoPath, manifest, run)
    if (!proof) return { code: 'E_MATERIAL_ADMIN_CONFLICT', digest, complete: true }
    if (proof.transform)
      return { code: 'E_MATERIAL_CHECKOUT_TRANSFORM_UNSUPPORTED', digest, complete: true }
    return {
      code: 'E_MATERIAL_CENSUS_UNVERIFIABLE',
      digest: hashCanonical({ inventory: digest, admin: proof.digest }),
      adminDigest: proof.digest,
      complete: true,
      route: 'checkout-index'
    }
  } catch {
    return { code: 'E_MATERIAL_INVENTORY_UNVERIFIABLE', digest: null, complete: false }
  }
}
