import { custodyResourceKey, type WorktreeCustodyFence } from './custody'
import type { SelectionAck, SelectionFrame } from './custody-selection'

export type SelectionSnapshot = { complete: boolean; workspaceIds: readonly string[] }
export const selectionFenceKey = (fence: WorktreeCustodyFence): string =>
  JSON.stringify([
    custodyResourceKey(fence.resource),
    fence.token,
    fence.authorityId,
    fence.capturedAt,
    fence.expiresAt
  ])

/** Local target admissions close synchronously before a native absence acknowledgement. */
export class WorktreeSelectionClient {
  private readonly blocked = new Map<string, WorktreeCustodyFence>()
  private readonly mounted = new Map<string, number>()
  private channel: { channelNonce: string; connectionId: string } | null = null
  private revision = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly incarnation: string,
    private readonly snapshot: () => SelectionSnapshot
  ) {}

  disconnect(): void {
    this.channel = null
    this.changed()
  }

  refresh(): void {
    this.changed()
  }

  seed(fences: readonly WorktreeCustodyFence[]): boolean {
    const keys = new Set([...this.blocked.keys(), ...fences.map(selectionFenceKey)])
    if (keys.size > 64) {
      return false
    }
    for (const fence of fences) {
      this.blocked.set(selectionFenceKey(fence), fence)
    }
    this.changed()
    return true
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = (): number => this.revision
  hasMounted(workspaceId: string): boolean {
    return this.mounted.has(workspaceId)
  }

  pendingFences(): WorktreeCustodyFence[] {
    return [...this.blocked.values()]
  }

  selectionSnapshot(): SelectionSnapshot {
    try {
      const current = this.snapshot()
      const workspaceIds = [...new Set([...current.workspaceIds, ...this.mounted.keys()])]
      return { complete: current.complete && workspaceIds.length <= 64, workspaceIds }
    } catch {
      return { complete: false, workspaceIds: [] }
    }
  }

  isReady(): boolean {
    return this.channel !== null
  }

  ownsChannel(nonce: string): boolean {
    return this.channel?.channelNonce === nonce
  }

  receive(frame: SelectionFrame): SelectionAck | null {
    if (frame.type === 'end') {
      this.disconnect()
      return null
    }
    if (frame.type === 'ready') {
      if (frame.clientIncarnation === this.incarnation) {
        this.channel = frame
        this.changed()
      }
      return null
    }
    const channel = this.channel
    if (!channel) {
      return null
    }
    if (frame.type === 'hold') {
      if (frame.channelNonce === channel.channelNonce && this.blocked.size < 64) {
        this.blocked.set(selectionFenceKey(frame.fence), frame.fence)
        this.changed()
      }
      return null
    }
    if (frame.type === 'settled') {
      if (frame.channelNonce === channel.channelNonce && frame.proof) {
        this.blocked.delete(selectionFenceKey(frame.fence))
        this.changed()
      }
      return null
    }
    const round = frame.round
    if (
      round.clientIncarnation !== this.incarnation ||
      round.channelNonce !== channel.channelNonce ||
      round.connectionId !== channel.connectionId
    ) {
      return null
    }
    const key = selectionFenceKey(round.fence)
    if (this.blocked.size >= 64 && !this.blocked.has(key)) {
      return { ...round, disposition: 'unknown' }
    }
    this.blocked.set(key, round.fence)
    this.changed()
    let disposition: SelectionAck['disposition'] = 'unknown'
    try {
      const selected = this.selectionSnapshot()
      if (selected.complete && selected.workspaceIds.length <= 64) {
        disposition =
          selected.workspaceIds.includes(round.fence.resource.worktreeId) ||
          this.mounted.has(round.fence.resource.worktreeId)
            ? 'held'
            : 'absent'
      }
    } catch {
      /* A failed client inventory never acknowledges absence. */
    }
    return { ...round, disposition }
  }

  canSelect(workspaceId: string): boolean {
    return ![...this.blocked.values()].some((fence) => fence.resource.worktreeId === workspaceId)
  }

  mount(workspaceId: string): (() => void) | null {
    const count = this.mounted.get(workspaceId) ?? 0
    if (count === 0 && !this.canSelect(workspaceId)) {
      return null
    }
    this.mounted.set(workspaceId, count + 1)
    this.changed()
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const remaining = (this.mounted.get(workspaceId) ?? 1) - 1
      if (remaining <= 0) {
        this.mounted.delete(workspaceId)
      } else {
        this.mounted.set(workspaceId, remaining)
      }
      this.changed()
    }
  }

  private changed(): void {
    this.revision++
    for (const listener of this.listeners) {
      listener()
    }
  }
}
