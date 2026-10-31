import { inspectProcessLiveness } from '../daemon/daemon-process-inspection'
import {
  compareOrcadProcessIdentity,
  readOrcadProcessIncarnation,
  readOrcadProcessStartedAtMs
} from './orcad-process-start-time'
import { readBoundedLockFile } from './orcad-instance-lock-reclaim'
import type { OrcadInstanceLock, OrcadLockRecord } from './orcad-instance-lock'

// The lock this process currently holds; custody uses it as its incarnation witness.
let heldLock: OrcadInstanceLock | null = null

export function recordHeldOrcadInstanceLock(lock: OrcadInstanceLock): void {
  heldLock = lock
}

export function forgetHeldOrcadInstanceLock(lock: OrcadInstanceLock): void {
  if (heldLock === lock) {
    heldLock = null
  }
}

/** Read-only: this process's lock, only while the canonical file still carries its nonce. */
export function heldOrcadInstanceLock(): OrcadInstanceLock | null {
  const held = heldLock
  if (!held) {
    return null
  }
  try {
    const current: unknown = JSON.parse(readBoundedLockFile(held.path) ?? '')
    return typeof current === 'object' &&
      current !== null &&
      'nonce' in current &&
      current.nonce === held.record.nonce
      ? held
      : null
  } catch {
    return null
  }
}

/** Positive exit only: ESRCH, or a PID now held by another incarnation; unqueryable is not exit. */
export function orcadLockHolderHasExited(
  record: Pick<OrcadLockRecord, 'pid' | 'startedAtMs' | 'linuxStartTicks' | 'bootId'>
): boolean {
  return (
    inspectProcessLiveness(record.pid).status === 'exited' ||
    compareOrcadProcessIdentity(record.pid, record, {
      startedAtMs: readOrcadProcessStartedAtMs,
      incarnation: readOrcadProcessIncarnation
    }) === 'differs'
  )
}
