import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CustodyJournal, CustodyRecord } from './worktree-custody-authority'
import type {
  WorktreeCustodyFence,
  WorktreeCustodyOutcome,
  WorktreeCustodyResource
} from '../../shared/worktree/custody'
import { custodyResourceKey } from '../../shared/worktree/custody'

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resource(value: unknown): value is WorktreeCustodyResource {
  return (
    object(value) &&
    ['worktreeId', 'path', 'instanceId', 'hostId', 'owner', 'product', 'task', 'generation'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 8192 && !value[key].includes('\0')
    )
  )
}

function fence(value: unknown): value is WorktreeCustodyFence {
  return object(value) && resource(value.resource) &&
    typeof value.token === 'string' && typeof value.authorityId === 'string' &&
    typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt) &&
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

function outcome(value: unknown): value is WorktreeCustodyOutcome {
  return object(value) && resource(value.resource) && typeof value.key === 'string' &&
    typeof value.state === 'string' && ['dispatched', 'retired', 'unknown', 'refused'].includes(value.state) &&
    typeof value.recordedAt === 'number' && Number.isFinite(value.recordedAt) &&
    (value.reason === null || typeof value.reason === 'string')
}

function record(value: unknown): value is CustodyRecord {
  if (!object(value) || !resource(value.resource) || typeof value.claim !== 'string' ||
    !(value.releaseProof === null || typeof value.releaseProof === 'string') ||
    typeof value.revoked !== 'boolean' || !(value.fence === null || fence(value.fence)) ||
    !(value.outcome === null || outcome(value.outcome))) return false
  const key = custodyResourceKey(value.resource)
  return (value.fence === null || custodyResourceKey(value.fence.resource) === key) &&
    (value.outcome === null || custodyResourceKey(value.outcome.resource) === key)
}

function noSymlinkAncestors(path: string): void {
  let current = resolve(path)
  const root = parse(current).root
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('custody_journal_symlink')
    if (current === root) return
    current = dirname(current)
  }
}

function syncDirectory(path: string): void {
  // Windows does not expose directory fsync; durable retirement stays unsupported there.
  if (process.platform === 'win32') throw new Error('custody_durability_unsupported')
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** A leftover writer lock is unknown after a crash; never steal it using age or PID absence. */
export class WorktreeCustodyFileJournal implements CustodyJournal {
  private revision: string | null = null

  constructor(private readonly directory: string) {}

  read(): CustodyRecord[] {
    if (!existsSync(this.directory)) return []
    this.checkDirectory()
    const path = join(this.directory, 'custody.json')
    if (!existsSync(path)) return []
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_JOURNAL_BYTES || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error('custody_journal_unsafe')
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!object(parsed) || parsed.version !== 1 || typeof parsed.revision !== 'string' ||
        !Array.isArray(parsed.records) || parsed.records.length > 2048 || !parsed.records.every(record)) {
        throw new Error('custody_journal_invalid')
      }
      const claims = new Set(parsed.records.map((entry) => entry.claim))
      const keys = new Set(parsed.records.map((entry) => custodyResourceKey(entry.resource)))
      const outcomes = parsed.records.flatMap((entry) => entry.outcome ? [entry.outcome.key] : [])
      if (claims.size !== parsed.records.length || keys.size !== parsed.records.length ||
        new Set(outcomes).size !== outcomes.length) throw new Error('custody_journal_duplicate')
      this.revision = parsed.revision
      return parsed.records
    } finally {
      closeSync(fd)
    }
  }

  write(records: readonly CustodyRecord[]): void {
    if (process.platform === 'win32') throw new Error('custody_durability_unsupported')
    if (!existsSync(this.directory)) {
      noSymlinkAncestors(dirname(this.directory))
      mkdirSync(this.directory, { mode: 0o700 })
      syncDirectory(dirname(this.directory))
    }
    this.checkDirectory()
    const lockPath = join(this.directory, 'writer.lock')
    const lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    const expectedRevision = this.revision
    let temporary: string | null = null
    try {
      this.read()
      if (this.revision !== expectedRevision) throw new Error('custody_journal_writer_changed')
      const revision = randomUUID()
      const body = JSON.stringify({ version: 1, revision, records })
      if (Buffer.byteLength(body) > MAX_JOURNAL_BYTES) throw new Error('custody_journal_full')
      temporary = join(this.directory, `${revision}.tmp`)
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        writeFileSync(fd, body, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, join(this.directory, 'custody.json'))
      temporary = null
      syncDirectory(this.directory)
      this.revision = revision
    } finally {
      closeSync(lock)
      if (temporary) unlinkSync(temporary)
      unlinkSync(lockPath)
      syncDirectory(this.directory)
    }
  }

  private checkDirectory(): void {
    noSymlinkAncestors(this.directory)
    const info = lstatSync(this.directory)
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error('custody_journal_unsafe')
  }
}
