import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ paste: vi.fn(async () => undefined), seed: vi.fn() }))

vi.mock('@/lib/launch-work-item-direct-agent', () => ({
  pasteDirectWorkItemDraftWhenAgentReady: mocks.paste
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: mocks.seed
}))

import { deliverDirectWorkItemPrompt } from './launch-work-item-direct-prompt-delivery'

const STARTUP_PLAN = { agent: 'codex', launchCommand: 'codex', draftPrompt: null } as const

function deliver(structuredSessionRequired: boolean) {
  return deliverDirectWorkItemPrompt({
    primaryTabId: 'tab-1',
    effectiveAgent: 'codex',
    draftContent: 'https://example.invalid/issues/1',
    promptDelivery: 'submit-after-ready',
    structuredSessionRequired,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delivery reads only `agent` and `draftPrompt` from the plan.
    startupPlan: STARTUP_PLAN as unknown as Parameters<
      typeof deliverDirectWorkItemPrompt
    >[0]['startupPlan'],
    draftLaunchedNatively: false
  })
}

describe('direct work item prompt delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('never pastes into a terminal for a strict Start', () => {
    expect(deliver(true)).toBe(false)
    expect(mocks.paste).not.toHaveBeenCalled()
    expect(mocks.seed).not.toHaveBeenCalled()
  })

  it('keeps the legacy terminal submit for a non-strict launch such as Fix Checks', () => {
    expect(deliver(false)).toBe(true)
    expect(mocks.paste).toHaveBeenCalledWith(
      expect.objectContaining({ primaryTabId: 'tab-1', submit: true, forcePaste: true })
    )
  })
})
