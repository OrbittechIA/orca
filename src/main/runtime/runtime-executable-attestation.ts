import { createHash } from 'node:crypto'
import { createReadStream as nodeCreateReadStream } from 'node:fs'
import { stat as nodeStat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { readBuildProvenance, type BuildProvenance } from '../../shared/build-provenance'

/**
 * What this host attests about the build running it.
 *
 * No path: a paired client does not need to know where the server is installed, and publishing it
 * would leak disk layout for nothing. The candidate is proved by the embedded identity plus hashes.
 */
export type RuntimeBuildAttestation = {
  /** sha256 of the Electron executable. Shared by every Orca build on one Electron version, so it
   *  alone never identifies a candidate; kept for clients that predate `attestationId`. */
  sha256: string
  bytes: number
  /** From the answering host, not the caller: the embedded identity carries neither. */
  platform: string
  arch: string
  buildProvenance: BuildProvenance | null
  /** The app code actually loaded. Optional for mixed versions: older hosts omit it. */
  appContent?: RuntimeAppContent
  /** sha256 over executable, app content and build id: differs for two builds that share an
   *  Electron binary but ship different `app.asar`. Optional for mixed versions. */
  attestationId?: string
}

export type RuntimeAppContent =
  | { kind: 'app-asar'; sha256: string; bytes: number }
  /** A dev or test run loads code from `out/`, which no candidate artifact can match. */
  | { kind: 'unpackaged' }

type FileReader = {
  stat: (path: string) => Promise<{ size: number }>
  open: (path: string) => AsyncIterable<Buffer | string>
}

type OriginalFs = {
  createReadStream: (path: string) => AsyncIterable<Buffer | string>
  promises: { stat: (path: string) => Promise<{ size: number }> }
}

function isOriginalFs(value: unknown): value is OriginalFs {
  if (!value || typeof value !== 'object') {
    return false
  }
  const promises: unknown = Reflect.get(value, 'promises')
  return (
    typeof Reflect.get(value, 'createReadStream') === 'function' &&
    !!promises &&
    typeof promises === 'object' &&
    typeof Reflect.get(promises, 'stat') === 'function'
  )
}

/** Electron patches `fs` to read `*.asar` as a directory; `original-fs` sees the archive file.
 *  Outside Electron (tests, CLI) that shim is absent and plain `fs` already reads it as a file. */
function resolveFileReader(): FileReader {
  try {
    const originalFs: unknown = createRequire(__filename)('original-fs')
    if (isOriginalFs(originalFs)) {
      return {
        stat: (path) => originalFs.promises.stat(path),
        open: (path) => originalFs.createReadStream(path)
      }
    }
  } catch {
    // Not inside Electron.
  }
  return { stat: nodeStat, open: nodeCreateReadStream }
}

async function hashFile(
  reader: FileReader,
  path: string
): Promise<{ sha256: string; bytes: number }> {
  const { size } = await reader.stat(path)
  const digest = createHash('sha256')
  for await (const chunk of reader.open(path)) {
    digest.update(chunk)
  }
  return { sha256: digest.digest('hex'), bytes: size }
}

export function runtimeAttestationId(args: {
  executableSha256: string
  appContent: RuntimeAppContent
  buildId: string | null
}): string {
  const content = args.appContent.kind === 'app-asar' ? args.appContent.sha256 : 'unpackaged'
  return createHash('sha256')
    .update(
      `orca-runtime-attestation:v1:${args.executableSha256}:${content}:${args.buildId ?? 'none'}`
    )
    .digest('hex')
}

export async function attestRuntimeBuild(args: {
  execPath: string
  /** `app.asar` of a packaged app; null when this process runs unpackaged. */
  appAsarPath: string | null
  buildProvenance: BuildProvenance | null
  platform: string
  arch: string
  reader?: FileReader
}): Promise<RuntimeBuildAttestation | null> {
  const reader = args.reader ?? resolveFileReader()
  try {
    const executable = await hashFile(reader, args.execPath)
    const appContent: RuntimeAppContent = args.appAsarPath
      ? { kind: 'app-asar', ...(await hashFile(reader, args.appAsarPath)) }
      : { kind: 'unpackaged' }
    return {
      sha256: executable.sha256,
      bytes: executable.bytes,
      platform: args.platform,
      arch: args.arch,
      buildProvenance: args.buildProvenance,
      appContent,
      attestationId: runtimeAttestationId({
        executableSha256: executable.sha256,
        appContent,
        buildId: args.buildProvenance?.buildId ?? null
      })
    }
  } catch {
    return null
  }
}

/** Packaged when Electron's resources directory holds the archive; a missing one means the app
 *  loads from `out/`, which is reported as unpackaged rather than guessed. */
async function packagedAppAsarPath(): Promise<string | null> {
  const resourcesPath: unknown = Reflect.get(process, 'resourcesPath')
  if (typeof resourcesPath !== 'string' || !process.versions.electron) {
    return null
  }
  const candidate = join(resourcesPath, 'app.asar')
  try {
    await resolveFileReader().stat(candidate)
    return candidate
  } catch {
    return null
  }
}

let cached: Promise<RuntimeBuildAttestation | null> | null = null

/**
 * Computed on demand and memoized.
 *
 * Deliberately outside `status.get`: hashing hundreds of MB in every process that starts would be
 * a startup regression paid by everyone to serve only E2E evidence.
 */
export function getRuntimeBuildAttestation(): Promise<RuntimeBuildAttestation | null> {
  cached ??= packagedAppAsarPath().then((appAsarPath) =>
    attestRuntimeBuild({
      execPath: process.execPath,
      appAsarPath,
      buildProvenance: readBuildProvenance(),
      platform: process.platform,
      arch: process.arch
    })
  )
  return cached
}

export function resetRuntimeBuildAttestationForTests(): void {
  cached = null
}
