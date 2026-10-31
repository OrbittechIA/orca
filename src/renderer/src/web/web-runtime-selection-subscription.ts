import { SelectionFrameSchema } from '../../../shared/worktree/custody-selection'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  WebRuntimeSubscriptionCallbacks,
  WebRuntimeTransportSubscriptionHandle
} from './web-runtime-subscription-contract'

/** Keep selection reports, rounds and teardown on the same authenticated connection. */
export async function subscribeWebRuntimeSelection(ports: {
  signal?: AbortSignal
  callbacks: WebRuntimeSubscriptionCallbacks
  subscribe: (
    callbacks: WebRuntimeSubscriptionCallbacks
  ) => Promise<WebRuntimeTransportSubscriptionHandle>
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
}): Promise<WebRuntimeTransportSubscriptionHandle> {
  let stopped = false
  let interrupted = false
  let remoteId: string | undefined
  let handle: WebRuntimeTransportSubscriptionHandle | undefined
  const release = (): void => {
    if (!remoteId) {
      if (interrupted) {
        handle?.unsubscribe()
        ports.signal?.removeEventListener('abort', stop)
      }
      return
    }
    const subscriptionId = remoteId
    void ports.call('workspace.selection.unsubscribe.v1', { subscriptionId }).then(
      (response) => {
        if (response.ok && remoteId === subscriptionId) {
          handle?.unsubscribe()
          ports.signal?.removeEventListener('abort', stop)
        }
      },
      () => {}
    )
  }
  handle = await ports.subscribe({
    ...ports.callbacks,
    onResponse: (response) => {
      if (response.ok) {
        const parsed = SelectionFrameSchema.safeParse(response.result)
        if (parsed.success && parsed.data.type === 'ready') {
          remoteId = parsed.data.subscriptionId
          interrupted = false
          if (stopped) {
            release()
            return
          }
        }
      }
      if (!stopped) {
        ports.callbacks.onResponse(response)
      } else if (!response.ok) {
        handle?.unsubscribe()
        ports.signal?.removeEventListener('abort', stop)
      }
    },
    onTransportInterrupted: () => {
      interrupted = true
      remoteId = undefined
      ports.callbacks.onTransportInterrupted?.()
      if (stopped) {
        handle?.unsubscribe()
        ports.signal?.removeEventListener('abort', stop)
      }
    }
  })
  function stop(): void {
    stopped = true
    release()
  }
  ports.signal?.addEventListener('abort', stop, { once: true })
  if (ports.signal?.aborted) {
    stop()
  }
  return {
    unsubscribe: stop,
    sendBinary: (bytes) => handle?.sendBinary(bytes)
  }
}
