import { admitWorktreeCustody, nativeWorktreeCustody } from './worktree-custody-runtime'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import type { WorktreeCustodyFence } from '../../shared/worktree/custody'
import type { SelectionAck, SelectionFrame } from '../../shared/worktree/custody-selection'
import { WorktreeCustodySelectionRounds } from './worktree-custody-selection-rounds'
import type { CustodySelectionLocation } from './worktree-custody-selection-location'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'

type SelectionConnection = {
  selected: Set<string> | null
  locations: Map<string, CustodySelectionLocation | null>
  headless: boolean
  channel: { nonce: string; close(): void } | null
  reportedComplete: boolean
  unrepresentedView: boolean
}
export type WorktreeSelectionAuthority = {
  readonly complete: boolean
  readonly generation: number
  selects: (worktreeId: string, path?: string, hostId?: string) => boolean
  acquire: (fence: WorktreeCustodyFence) => Promise<{ check(): boolean; release(): void }>
  settle: (fence: WorktreeCustodyFence) => void
}

const profiles = new Map<string, WorktreeCustodySelections>()

export function nativeWorktreeCustodySelections(): WorktreeCustodySelections {
  if (!hasAppEnvironment()) {
    return new WorktreeCustodySelections()
  }
  const key = join(getAppEnvironment().getPath('userData'), 'worktree-custody-v1')
  let inventory = profiles.get(key)
  if (!inventory) {
    inventory = new WorktreeCustodySelections()
    profiles.set(key, inventory)
  }
  return inventory
}

/** Transport-owned inventory; presence expiry never releases a selected workspace. */
export class WorktreeCustodySelections {
  private readonly connections = new Map<string, SelectionConnection>()
  private readonly selectedCounts = new Map<string, number>()
  private unknown = 0
  private revision = 0
  private unrepresented = false
  private readonly rounds: WorktreeCustodySelectionRounds

  constructor(
    private readonly admit: typeof admitWorktreeCustody = admitWorktreeCustody,
    settlement: (fence: WorktreeCustodyFence) => string | null = (fence) =>
      nativeWorktreeCustody()?.clientFenceSettlement(fence) ?? null,
    private readonly resolveLocation: (id: string) => CustodySelectionLocation | null = () => null
  ) {
    this.rounds = new WorktreeCustodySelectionRounds({
      generation: () => this.generation,
      complete: () => this.complete,
      settlement
    })
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId)
  }

  holdUnrepresentedConnection(): void {
    if (!this.unrepresented) {
      this.unrepresented = true
      this.unknown++
      this.revision++
    }
  }

  open(connectionId: string): () => void {
    if (this.connections.has(connectionId)) {
      throw new Error('custody_selection_connection_reused')
    }
    const connection: SelectionConnection = {
      selected: null,
      locations: new Map(),
      headless: false,
      channel: null,
      reportedComplete: false,
      unrepresentedView: false
    }
    this.connections.set(connectionId, connection)
    this.unknown++
    this.revision++
    return () => {
      if (this.connections.get(connectionId) !== connection) {
        return
      }
      this.removeSelection(connection)
      this.unknown -= Number(this.isUnknown(connection))
      connection.channel?.close()
      this.connections.delete(connectionId)
      this.revision++
    }
  }

  report(
    connectionId: string,
    workspaceIds: readonly string[],
    kind: 'headless' | 'view' = 'view',
    complete = true,
    resolveLocation = this.resolveLocation
  ): void {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new Error('custody_selection_connection_closed')
    }
    if (kind === 'headless' && connection.channel) {
      throw new Error('custody_selection_role_changed')
    }
    if (!complete) {
      this.change(connection, () => {
        connection.reportedComplete = false
      })
      return
    }
    if (
      workspaceIds.length > 64 ||
      (kind === 'headless' && workspaceIds.length !== 0) ||
      workspaceIds.some((id) => !id || id.length > 8192 || id.includes('\0'))
    ) {
      throw new Error('custody_selection_report_invalid')
    }
    const selected = new Set(workspaceIds)
    const locations = new Map(
      [...selected].map((id) => {
        let location: CustodySelectionLocation | null = null
        try {
          location = resolveLocation(id)
        } catch {
          // An unreadable owner keeps this view represented as unknown.
        }
        return [id, location] as const
      })
    )
    const known = [...locations.values()].every((location) => location !== null)
    if (
      connection.selected?.size === selected.size &&
      connection.headless === (kind === 'headless') &&
      connection.reportedComplete &&
      known &&
      [...selected].every((id) => {
        const previous = connection.locations.get(id)
        const next = locations.get(id)
        return (
          connection.selected?.has(id) &&
          previous?.hostId === next?.hostId &&
          previous?.path === next?.path
        )
      })
    ) {
      return
    }
    const releases: (() => void)[] = []
    try {
      for (const [id, location] of locations) {
        if (location?.hostId === 'local') {
          releases.push(this.admit(id, location.path, location.hostId, false))
        }
      }
      this.change(connection, () => {
        this.removeSelection(connection)
        connection.selected = selected
        connection.locations = locations
        connection.headless = kind === 'headless'
        connection.reportedComplete = known
        for (const id of selected) {
          this.selectedCounts.set(id, (this.selectedCounts.get(id) ?? 0) + 1)
        }
      })
    } catch (error) {
      this.change(connection, () => {
        connection.reportedComplete = false
      })
      throw error
    } finally {
      for (const release of releases) {
        release()
      }
    }
  }

  watch(
    connectionId: string,
    incarnation: string,
    emit: (frame: SelectionFrame) => void
  ): () => void {
    const connection = this.connections.get(connectionId)
    if (connection?.channel) {
      this.change(connection, () => {
        connection.unrepresentedView = true
      })
    }
    if (!connection || connection.channel) {
      throw new Error('custody_selection_connection_changed')
    }
    const channel = this.rounds.attach(connectionId, incarnation, emit)
    this.change(connection, () => {
      connection.channel = channel
    })
    return () => {
      if (this.connections.get(connectionId) !== connection || connection.channel !== channel) {
        return
      }
      this.change(connection, () => {
        connection.channel = null
      })
      channel.close()
    }
  }

  acknowledge(connectionId: string, ack: SelectionAck): void {
    this.rounds.acknowledge(connectionId, ack)
  }
  reconcile(connectionId: string, nonce: string, fences: readonly WorktreeCustodyFence[]): void {
    this.rounds.reconcile(connectionId, nonce, fences)
  }
  acquire(fence: WorktreeCustodyFence) {
    return this.rounds.acquire(fence)
  }
  settle(fence: WorktreeCustodyFence): void {
    this.rounds.settle(fence)
  }

  get complete(): boolean {
    return this.unknown === 0
  }

  get generation(): number {
    return this.revision
  }

  selects(worktreeId: string, path?: string, hostId?: string): boolean {
    if (this.unknown > 0) {
      return true
    }
    if (path === undefined || hostId === undefined) {
      return this.selectedCounts.has(worktreeId)
    }
    const target = normalizeRuntimePathForComparison(path)
    for (const connection of this.connections.values()) {
      for (const location of connection.locations.values()) {
        if (location?.hostId === hostId) {
          const selected = normalizeRuntimePathForComparison(location.path)
          if (isPathInsideOrEqual(selected, target) || isPathInsideOrEqual(target, selected)) {
            return true
          }
        }
      }
    }
    return false
  }

  private removeSelection(connection: SelectionConnection): void {
    if (connection.selected === null) {
      return
    }
    for (const id of connection.selected) {
      const count = this.selectedCounts.get(id) ?? 0
      if (count <= 1) {
        this.selectedCounts.delete(id)
      } else {
        this.selectedCounts.set(id, count - 1)
      }
    }
  }

  private isUnknown(connection: SelectionConnection): boolean {
    return (
      !connection.reportedComplete ||
      connection.unrepresentedView ||
      connection.selected === null ||
      (!connection.headless && connection.channel === null)
    )
  }

  private change(connection: SelectionConnection, mutate: () => void): void {
    const before = this.isUnknown(connection)
    mutate()
    this.unknown += Number(this.isUnknown(connection)) - Number(before)
    this.revision++
  }
}
