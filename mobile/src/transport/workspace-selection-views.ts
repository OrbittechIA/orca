import { createUuidV4 } from '../../../src/shared/uuid-v4'
import type { WorktreeCustodyFence } from '../../../src/shared/worktree/custody'
import type {
  SelectionAck,
  SelectionFrame,
  SelectionRound
} from '../../../src/shared/worktree/custody-selection'
import {
  selectionFenceKey,
  type SelectionSnapshot
} from '../../../src/shared/worktree/custody-selection-client'

type View = {
  capable: boolean
  complete: boolean
  workspaceIds: string[]
  unrepresented: boolean
  channel?: { nonce: string; incarnation: string; emit(frame: SelectionFrame): void }
}
type Pending = {
  view: string
  round: SelectionRound
  finish(value: SelectionAck['disposition']): void
}

/** One physical mobile channel owns every page's target admissions. */
export class WorkspaceSelectionViews {
  private readonly views = new Map<string, View>()
  private readonly pending = new Map<string, Pending>()
  private generation = 0
  private unrepresented = false
  get version(): number {
    return this.generation
  }

  constructor(
    private readonly ports: {
      changed(): void
      fences(): WorktreeCustodyFence[]
      reconcile(fences: WorktreeCustodyFence[]): void
    }
  ) {}

  open(id: string): boolean {
    if (this.views.has(id)) {
      return true
    }
    if (this.views.size >= 64) {
      this.unrepresented = true
      this.changed()
      return false
    }
    this.views.set(id, { capable: false, complete: false, workspaceIds: [], unrepresented: false })
    this.changed()
    return true
  }

  close(id: string): void {
    if (this.views.delete(id)) {
      this.changed()
    }
  }

  invalidate(id: string): void {
    const view = this.views.get(id)
    if (view?.complete) {
      view.complete = false
      this.changed()
    }
  }

  capability(id: string, capable: boolean): void {
    const view = this.require(id)
    if (view.capable !== capable) {
      view.capable = capable
      this.changed()
    }
  }

  report(id: string, workspaceIds: readonly string[], complete: boolean): void {
    const view = this.require(id)
    const ids = [...new Set(workspaceIds)]
    if (ids.length > 64) {
      throw new Error('custody_selection_view_overflow')
    }
    if (
      view.complete === complete &&
      ids.length === view.workspaceIds.length &&
      ids.every((value) => view.workspaceIds.includes(value))
    ) {
      return
    }
    view.complete = complete
    if (complete) {
      view.workspaceIds = ids
    }
    this.changed()
  }

  snapshot(): SelectionSnapshot {
    const workspaceIds = [...new Set([...this.views.values()].flatMap((view) => view.workspaceIds))]
    return {
      workspaceIds,
      complete:
        !this.unrepresented &&
        workspaceIds.length <= 64 &&
        [...this.views.values()].every(
          (view) =>
            view.capable && view.complete && !view.unrepresented && view.channel !== undefined
        )
    }
  }

  watch(id: string, incarnation: string, emit: (frame: SelectionFrame) => void): () => void {
    const view = this.require(id)
    if (view.channel) {
      view.unrepresented = true
      this.changed()
    }
    if (!view.capable || view.channel) {
      throw new Error('custody_selection_view_unqualified')
    }
    const channel = { nonce: createUuidV4(), incarnation, emit }
    view.channel = channel
    this.changed()
    emit({
      type: 'ready',
      channelNonce: channel.nonce,
      clientIncarnation: incarnation,
      connectionId: id,
      subscriptionId: `selection-view:${id}:${channel.nonce}`
    })
    for (const fence of this.ports.fences()) {
      emit({ type: 'hold', channelNonce: channel.nonce, fence })
    }
    return () => {
      if (view.channel === channel) {
        delete view.channel
        view.complete = false
        this.changed()
      }
    }
  }

  acknowledge(id: string, ack: SelectionAck): void {
    const held = this.pending.get(ack.nonce)
    const channel = this.require(id).channel
    if (
      !held ||
      held.view !== id ||
      !channel ||
      ack.connectionId !== id ||
      ack.channelNonce !== channel.nonce ||
      ack.clientIncarnation !== channel.incarnation ||
      held.round.channelNonce !== ack.channelNonce ||
      selectionFenceKey(held.round.fence) !== selectionFenceKey(ack.fence)
    ) {
      throw new Error('custody_selection_view_ack_changed')
    }
    held.finish(ack.disposition)
  }

  reconcile(id: string, nonce: string, fences: WorktreeCustodyFence[]): void {
    if (this.require(id).channel?.nonce !== nonce) {
      throw new Error('custody_selection_view_channel_changed')
    }
    this.ports.reconcile(fences)
  }

  native(frame: SelectionFrame): void {
    if (frame.type !== 'hold' && frame.type !== 'settled') {
      return
    }
    for (const view of this.views.values()) {
      const channel = view.channel
      if (channel) {
        channel.emit({ ...frame, channelNonce: channel.nonce })
      }
    }
    this.ports.changed()
  }

  async round(round: SelectionRound): Promise<SelectionAck['disposition']> {
    const generation = this.generation
    const nonces: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const replies = [...this.views].map(([id, view]) => {
        const channel = view.channel
        if (!view.capable || !view.complete || view.unrepresented || !channel) {
          return Promise.resolve('unknown' as const)
        }
        const local = {
          fence: round.fence,
          nonce: createUuidV4(),
          clientIncarnation: channel.incarnation,
          channelNonce: channel.nonce,
          connectionId: id
        }
        nonces.push(local.nonce)
        const reply = new Promise<SelectionAck['disposition']>((finish) => {
          this.pending.set(local.nonce, { view: id, round: local, finish })
        })
        try {
          channel.emit({ type: 'fence', round: local })
        } catch {
          this.pending.get(local.nonce)?.finish('unknown')
        }
        return reply
      })
      const result = await Promise.race([
        Promise.all(replies),
        new Promise<SelectionAck['disposition'][]>((resolve) => {
          timer = setTimeout(() => resolve(['unknown']), 4_000)
        })
      ])
      if (this.generation !== generation || result.includes('unknown')) {
        return 'unknown'
      }
      return result.includes('held') ? 'held' : 'absent'
    } finally {
      clearTimeout(timer)
      for (const nonce of nonces) {
        this.pending.delete(nonce)
      }
    }
  }

  private require(id: string): View {
    const view = this.views.get(id)
    if (!view) {
      throw new Error('custody_selection_view_closed')
    }
    return view
  }
  private changed(): void {
    this.generation++
    for (const wait of this.pending.values()) {
      wait.finish('unknown')
    }
    this.ports.changed()
  }
}
