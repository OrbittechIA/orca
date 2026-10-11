import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function createLocalBuildVersion(baseVersion, timestamp, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('Local build timestamp is invalid.')
  }
  const sanitizedCommit = commit.replace(/[^0-9A-Za-z-]/g, '').slice(0, 12)
  if (!sanitizedCommit) {
    throw new Error('Git commit identity is empty.')
  }
  const suffix = `local.${timestamp}.${sanitizedCommit}`
  return baseVersion.includes('-') ? `${baseVersion}.${suffix}` : `${baseVersion}-${suffix}`
}

/**
 * `commit` is the FULL sha: it is handed to the packager as `ORCA_BUILD_COMMIT`, which
 * build-provenance validates against `git rev-parse HEAD` and would refuse abbreviated (the
 * local mac build rejected itself that way). Only the human version suffix abbreviates it,
 * inside `createLocalBuildVersion`.
 */
export function getLocalBuildIdentity({
  run = execFileSync,
  now = Date.now,
  packageJsonPath = resolve('package.json')
} = {}) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const commit = String(run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git did not name a full commit: ${commit}`)
  }
  return {
    commit,
    version: createLocalBuildVersion(packageJson.version, now(), commit)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getLocalBuildIdentity()
  console.log(`[build:mac] local update version ${identity.version}`)
  execFileSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'electron-builder', '--config', 'config/electron-builder.config.cjs', '--mac'],
    {
      env: {
        ...process.env,
        ORCA_BUILD_COMMIT: identity.commit,
        ORCA_LOCAL_BUILD_VERSION: identity.version
      },
      stdio: 'inherit'
    }
  )
}
