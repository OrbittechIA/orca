import { admitWorktreeCustody } from './worktree-custody-runtime'

type SelectionConnection = { selected: Set<string> | null }
export type WorktreeSelectionAuthority = {
  readonly complete?: boolean
  readonly generation?: number
  selects: (worktreeId: string) => boolean
}

/** Transport-owned inventory; presence expiry never releases a selected workspace. */
export class WorktreeCustodySelections {
  private readonly connections = new Map<string, SelectionConnection>()
  private readonly selectedCounts = new Map<string, number>()
  private unknown = 0
  private revision = 0
  private unrepresented = false

  constructor(private readonly admit: (worktreeId: string) => () => void = admitWorktreeCustody) {}

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
    const connection: SelectionConnection = { selected: null }
    this.connections.set(connectionId, connection)
    this.unknown++
    this.revision++
    return () => {
      if (this.connections.get(connectionId) !== connection) {
        return
      }
      this.removeSelection(connection)
      this.connections.delete(connectionId)
      this.revision++
    }
  }

  report(connectionId: string, workspaceIds: readonly string[]): void {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      throw new Error('custody_selection_connection_closed')
    }
    if (
      workspaceIds.length > 64 ||
      workspaceIds.some((id) => !id || id.length > 8192 || id.includes('\0'))
    ) {
      throw new Error('custody_selection_report_invalid')
    }
    const selected = new Set(workspaceIds)
    if (
      connection.selected?.size === selected.size &&
      [...selected].every((id) => connection.selected?.has(id))
    ) {
      return
    }
    const releases: (() => void)[] = []
    try {
      // Selecting a fenced resource refuses before the client may acknowledge its selection.
      for (const id of selected) {
        if (!connection.selected?.has(id)) {
          releases.push(this.admit(id))
        }
      }
      this.removeSelection(connection)
      connection.selected = selected
      this.revision++
      for (const id of selected) {
        this.selectedCounts.set(id, (this.selectedCounts.get(id) ?? 0) + 1)
      }
    } finally {
      for (const release of releases) {
        release()
      }
    }
  }

  get complete(): boolean {
    return this.unknown === 0
  }

  get generation(): number {
    return this.revision
  }

  selects(worktreeId: string): boolean {
    return this.unknown > 0 || this.selectedCounts.has(worktreeId)
  }

  private removeSelection(connection: SelectionConnection): void {
    if (connection.selected === null) {
      this.unknown--
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
}
