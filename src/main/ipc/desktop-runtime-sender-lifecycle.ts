import type { WebContents } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type SenderState = {
  connectionId: string
  sender: WebContents
  subscriptions: Map<string, AbortController>
  releaseSelection: (() => void) | undefined
}

type CleanupRuntime = Pick<OrcaRuntimeService, 'cleanupSubscriptionsForConnection'> &
  Partial<Pick<OrcaRuntimeService, 'custodySelections'>>

export class DesktopRuntimeSenderLifecycle {
  private readonly senders = new Map<number, SenderState>()
  private nextConnectionGeneration = 1

  constructor(private readonly runtime: CleanupRuntime) {}

  connectionIdFor(sender: WebContents): string {
    return this.stateFor(sender).connectionId
  }

  subscriptionsFor(sender: WebContents): Map<string, AbortController> {
    return this.stateFor(sender).subscriptions
  }

  existingSubscriptionsFor(sender: WebContents): Map<string, AbortController> | null {
    const state = this.senders.get(sender.id)
    return state?.sender === sender ? state.subscriptions : null
  }

  private stateFor(sender: WebContents): SenderState {
    const existing = this.senders.get(sender.id)
    if (existing?.sender === sender) {
      return existing
    }
    if (existing) {
      this.retire(existing, true)
    }
    const connectionId = this.mintConnectionId(sender.id)
    const state: SenderState = {
      connectionId,
      sender,
      subscriptions: new Map(),
      releaseSelection: this.runtime.custodySelections?.open(connectionId)
    }
    this.senders.set(sender.id, state)
    const retireDocument = (): void => this.retire(state, false)
    sender.on('did-navigate', retireDocument)
    sender.on('render-process-gone', retireDocument)
    sender.once('destroyed', () => this.retire(state, true))
    return state
  }

  private retire(state: SenderState, destroyed: boolean): void {
    if (this.senders.get(state.sender.id) !== state) {
      return
    }
    const retiredConnectionId = state.connectionId
    state.releaseSelection?.()
    if (destroyed) {
      this.senders.delete(state.sender.id)
    } else {
      state.connectionId = this.mintConnectionId(state.sender.id)
      state.releaseSelection = this.runtime.custodySelections?.open(state.connectionId)
    }
    for (const controller of state.subscriptions.values()) {
      controller.abort()
    }
    state.subscriptions.clear()
    this.runtime.cleanupSubscriptionsForConnection(retiredConnectionId)
  }

  private mintConnectionId(senderId: number): string {
    return `desktop-renderer:${senderId}:${this.nextConnectionGeneration++}`
  }
}
