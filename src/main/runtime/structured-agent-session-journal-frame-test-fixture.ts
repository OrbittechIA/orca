import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'

export function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}

export function itemsOf(frames: AgentSessionSubscribeEvent[]): AgentJournalRenderItem[] {
  const items = new Map<string, AgentJournalRenderItem>()
  for (const frame of frames) {
    const published =
      frame.type === 'snapshot' || frame.type === 'reset'
        ? frame.page.items
        : frame.type === 'batch'
          ? frame.batch.items
          : []
    for (const item of published) {
      items.set(item.itemId, item)
    }
  }
  return [...items.values()]
}

export function cursorOf(frames: AgentSessionSubscribeEvent[]): {
  epoch: string
  sequence: number
} {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (frame?.type === 'batch') {
      return frame.batch.cursor
    }
    if (frame?.type === 'snapshot' || frame?.type === 'reset') {
      return frame.page.liveCursor ?? frame.page.window.nextCursor
    }
  }
  throw new Error('subscription published no cursor')
}
