import { randomUUID } from 'node:crypto'
import { custodyResourceKey, type WorktreeCustodyFence } from '../../shared/worktree/custody'
import type {
  SelectionAck,
  SelectionFrame,
  SelectionRound
} from '../../shared/worktree/custody-selection'

const fenceKey = (fence: WorktreeCustodyFence): string =>
  JSON.stringify([
    custodyResourceKey(fence.resource),
    fence.token,
    fence.authorityId,
    fence.capturedAt,
    fence.expiresAt
  ])
type Channel = { nonce: string; clientIncarnation: string; emit: (frame: SelectionFrame) => void }
type Pending = { round: SelectionRound; resolve(): void; reject(error: Error): void }

/** Native target rounds; only an owning durable settlement can release a client admission. */
export class WorktreeCustodySelectionRounds {
  private readonly channels = new Map<string, Channel>()
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly ports: {
      generation(): number
      complete(): boolean
      settlement(fence: WorktreeCustodyFence): string | null
    }
  ) {}

  attach(
    connectionId: string,
    clientIncarnation: string,
    emit: Channel['emit']
  ): { nonce: string; close(): void } {
    if (this.channels.has(connectionId)) {
      throw new Error('custody_selection_channel_already_open')
    }
    const channel = { nonce: randomUUID(), clientIncarnation, emit }
    this.channels.set(connectionId, channel)
    try {
      emit({ type: 'ready', channelNonce: channel.nonce, clientIncarnation, connectionId })
    } catch (error) {
      this.channels.delete(connectionId)
      throw error
    }
    return {
      nonce: channel.nonce,
      close: () => {
        if (this.channels.get(connectionId) !== channel) {
          return
        }
        this.channels.delete(connectionId)
        for (const pending of this.pending.values()) {
          if (pending.round.channelNonce === channel.nonce) {
            pending.reject(new Error('custody_selection_client_disconnected'))
          }
        }
      }
    }
  }

  acknowledge(connectionId: string, ack: SelectionAck): void {
    const pending = this.pending.get(ack.nonce)
    if (
      !pending ||
      ack.connectionId !== connectionId ||
      this.channels.get(connectionId)?.nonce !== ack.channelNonce ||
      pending.round.connectionId !== connectionId ||
      pending.round.channelNonce !== ack.channelNonce ||
      pending.round.clientIncarnation !== ack.clientIncarnation ||
      fenceKey(pending.round.fence) !== fenceKey(ack.fence)
    ) {
      throw new Error('custody_selection_ack_binding_changed')
    }
    if (ack.disposition === 'absent') {
      pending.resolve()
    } else {
      pending.reject(new Error(`custody_selection_${ack.disposition}`))
    }
  }

  reconcile(connectionId: string, nonce: string, fences: readonly WorktreeCustodyFence[]): void {
    const channel = this.channels.get(connectionId)
    if (!channel || channel.nonce !== nonce) {
      throw new Error('custody_selection_channel_changed')
    }
    for (const fence of fences) {
      const proof = this.ports.settlement(fence)
      if (proof) {
        channel.emit({ type: 'settled', channelNonce: nonce, fence, proof })
      }
    }
  }

  settle(fence: WorktreeCustodyFence): void {
    const proof = this.ports.settlement(fence)
    if (!proof) {
      throw new Error('custody_selection_settlement_unproven')
    }
    let failed = false
    for (const channel of this.channels.values()) {
      try {
        channel.emit({ type: 'settled', channelNonce: channel.nonce, fence, proof })
      } catch {
        failed = true
      }
    }
    if (failed) {
      throw new Error('custody_selection_settlement_delivery_pending')
    }
  }

  async acquire(fence: WorktreeCustodyFence): Promise<{ check(): boolean; release(): void }> {
    if (!this.ports.complete()) {
      throw new Error('custody_selection_inventory_unknown')
    }
    const generation = this.ports.generation()
    const nonces: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const acknowledgements = [...this.channels].map(([connectionId, channel]) => {
        const round = {
          fence,
          connectionId,
          channelNonce: channel.nonce,
          clientIncarnation: channel.clientIncarnation,
          nonce: randomUUID()
        }
        nonces.push(round.nonce)
        const wait = new Promise<void>((resolve, reject) => {
          this.pending.set(round.nonce, { round, resolve, reject })
        })
        void wait.catch(() => {})
        try {
          channel.emit({ type: 'fence', round })
        } catch {
          this.pending.get(round.nonce)?.reject(new Error('custody_selection_channel_unavailable'))
        }
        return wait
      })
      await Promise.race([
        Promise.all(acknowledgements),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('custody_selection_ack_timeout')), 5_000)
        })
      ])
      if (!this.ports.complete() || this.ports.generation() !== generation) {
        throw new Error('custody_selection_inventory_changed')
      }
      let released = false
      return {
        check: () => !released && this.ports.complete() && this.ports.generation() === generation,
        release: () => {
          this.settle(fence)
          released = true
        }
      }
    } finally {
      clearTimeout(timer)
      for (const nonce of nonces) {
        this.pending.delete(nonce)
      }
    }
  }
}
