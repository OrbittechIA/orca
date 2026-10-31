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
import type { CustodyJournal, CustodyState } from './worktree-custody-records'
import { custodyResourceKey } from '../../shared/worktree/custody'
import { custodyJournalRecord, custodyJournalReceipt } from './worktree-custody-journal-records'
import { custodyClientCancellationsValid } from './worktree-custody-records'
import { custodyEpochSealIsValid as epochSeal } from './worktree-custody-epoch-seal'

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function noSymlinkAncestors(path: string): void {
  let current = resolve(path)
  const root = parse(current).root
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error('custody_journal_symlink')
    }
    if (current === root) {
      return
    }
    current = dirname(current)
  }
}

function syncDirectory(path: string): void {
  // Windows does not expose directory fsync; durable retirement stays unsupported there.
  if (process.platform === 'win32') {
    throw new Error('custody_durability_unsupported')
  }
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

  read(): CustodyState {
    const empty = { records: [], receipts: [] }
    if (!lstatSync(this.directory, { throwIfNoEntry: false })) {
      return empty
    }
    this.checkDirectory()
    const path = join(this.directory, 'custody.json')
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      return empty
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = fstatSync(fd)
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > MAX_JOURNAL_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        throw new Error('custody_journal_unsafe')
      }
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (
        !object(parsed) ||
        (parsed.version !== 1 &&
          parsed.version !== 2 &&
          parsed.version !== 3 &&
          parsed.version !== 4 &&
          parsed.version !== 5) ||
        typeof parsed.revision !== 'string' ||
        !Array.isArray(parsed.records) ||
        parsed.records.length > 2048 ||
        !parsed.records.every(custodyJournalRecord)
      ) {
        throw new Error('custody_journal_invalid')
      }
      const receipts = parsed.version === 1 ? [] : parsed.receipts
      if (
        !Array.isArray(receipts) ||
        receipts.length > 16384 ||
        !receipts.every(custodyJournalReceipt) ||
        !custodyClientCancellationsValid(parsed.clientCancellations)
      ) {
        throw new Error('custody_journal_invalid')
      }
      const seal = parsed.epochSeal
      if (
        seal !== undefined &&
        ((parsed.version !== 4 && parsed.version !== 5) || !epochSeal(seal))
      ) {
        throw new Error('custody_journal_invalid')
      }
      const claims = new Set(parsed.records.map((entry) => entry.claim))
      const keys = new Set(parsed.records.map((entry) => custodyResourceKey(entry.resource)))
      const outcomes = parsed.records.flatMap((entry) => (entry.outcome ? [entry.outcome.key] : []))
      if (
        claims.size !== parsed.records.length ||
        keys.size !== parsed.records.length ||
        new Set(outcomes).size !== outcomes.length ||
        new Set(
          receipts.filter((entry) => entry.state !== 'refused').map((entry) => entry.resourceHash)
        ).size !== receipts.filter((entry) => entry.state !== 'refused').length ||
        new Set(receipts.map((entry) => entry.keyHash)).size !== receipts.length
      ) {
        throw new Error('custody_journal_duplicate')
      }
      this.revision = parsed.revision
      return {
        records: parsed.records,
        receipts,
        ...(parsed.clientCancellations ? { clientCancellations: parsed.clientCancellations } : {}),
        ...(epochSeal(seal) ? { epochSeal: seal } : {})
      }
    } finally {
      closeSync(fd)
    }
  }

  write(state: CustodyState): void {
    if (process.platform === 'win32') {
      throw new Error('custody_durability_unsupported')
    }
    const revision = randomUUID()
    const body = JSON.stringify({ version: 5, revision, ...state })
    if (
      state.records.length > 2048 ||
      state.receipts.length > 16384 ||
      !custodyClientCancellationsValid(state.clientCancellations) ||
      Buffer.byteLength(body) > MAX_JOURNAL_BYTES
    ) {
      throw new Error('custody_journal_full')
    }
    if (!existsSync(this.directory)) {
      noSymlinkAncestors(dirname(this.directory))
      mkdirSync(this.directory, { mode: 0o700 })
      syncDirectory(dirname(this.directory))
    }
    this.checkDirectory()
    const lockPath = join(this.directory, 'writer.lock')
    const lock = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    )
    const expectedRevision = this.revision
    let temporary: string | null = null
    try {
      this.read()
      if (this.revision !== expectedRevision) {
        throw new Error('custody_journal_writer_changed')
      }
      temporary = join(this.directory, `${revision}.tmp`)
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      )
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
      if (temporary) {
        unlinkSync(temporary)
      }
      unlinkSync(lockPath)
      syncDirectory(this.directory)
    }
  }

  private checkDirectory(): void {
    noSymlinkAncestors(this.directory)
    const info = lstatSync(this.directory)
    if (
      !info.isDirectory() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    ) {
      throw new Error('custody_journal_unsafe')
    }
  }
}
