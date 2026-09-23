import { beforeEach, describe, expect, it, vi } from 'vitest'

// The setting that decides whether a Work Item Start is structured is enforced by the HOST.
// This client used to keep its own copy and never read the host's, so the two disagreed and
// both directions were broken: a host on `submit-after-ready` still got the legacy terminal
// Start from here, and a client that set it locally dropped the terminal startup for a
// session the host then refused — a workspace with no writer at all.

const callRuntimeResult = vi.fn()

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: (...args: unknown[]) => callRuntimeResult(...args)
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'env-1' }),
  webRuntimeState: {
    worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
    worktreeVisibilityDefaultsRuntimeValue: null
  }
}))
vi.mock('../web-runtime-environment', () => ({
  readStoredWebRuntimeEnvironment: () => ({ id: 'env-1' })
}))

const storage = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear()
}
vi.stubGlobal('localStorage', localStorage)
vi.stubGlobal('window', { localStorage })

beforeEach(() => {
  storage.clear()
  callRuntimeResult.mockReset()
})

describe('work item start prompt delivery is host-owned', () => {
  it('reads the host value instead of the local default', async () => {
    const { getRuntimeBackedStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockResolvedValue({
      settings: { workItemStartPromptDelivery: 'submit-after-ready' }
    })

    const settings = await getRuntimeBackedStoredSettings()

    expect(settings.workItemStartPromptDelivery).toBe('submit-after-ready')
  })

  it('does not invent a value the host never sent', async () => {
    const { getRuntimeBackedStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockResolvedValue({ settings: {} })

    const settings = await getRuntimeBackedStoredSettings()

    expect(settings.workItemStartPromptDelivery).not.toBe('submit-after-ready')
  })

  it('refuses to report a save the host did not take', async () => {
    // Swallowing this is how the client ends up believing `submit-after-ready` while the
    // host still answers `draft`: the next Start drops the terminal for a session the host
    // then definitively refuses, and the workspace is left with no writer at all.
    const { syncRuntimeBackedSettings, getStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockRejectedValue(new Error('runtime_unreachable'))

    await expect(
      syncRuntimeBackedSettings(
        { workItemStartPromptDelivery: 'submit-after-ready' },
        {
          ...getStoredSettings(),
          workItemStartPromptDelivery: 'submit-after-ready'
        }
      )
    ).rejects.toThrow('runtime_unreachable')
  })

  it('still keeps a purely local setting when the host is unreachable', async () => {
    const { syncRuntimeBackedSettings, getStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockRejectedValue(new Error('runtime_unreachable'))

    await expect(
      syncRuntimeBackedSettings(
        { compactWorktreeCards: true },
        {
          ...getStoredSettings(),
          compactWorktreeCards: true
        }
      )
    ).resolves.toMatchObject({ compactWorktreeCards: true })
  })

  it('does not leave the local copy ahead of the host when the write fails', async () => {
    // Rethrowing is only half of it. The optimistic write lands in localStorage BEFORE the
    // sync, so without a rollback the client still believes `submit-after-ready` while the
    // host holds `draft` — noisy instead of silent, and the same divergence: the next Start
    // takes the strict route, drops the terminal startup, and the host refuses it.
    const api = await import('./web-settings-api')
    const { getStoredSettings } = await import('./web-preferences-store')
    const before = getStoredSettings().workItemStartPromptDelivery
    callRuntimeResult.mockRejectedValue(new Error('runtime_unreachable'))

    const settingsApi = api.createWebSettingsApi().settings
    if (!settingsApi) {
      throw new Error('web settings api is unavailable')
    }
    await expect(
      settingsApi.set({ workItemStartPromptDelivery: 'submit-after-ready' })
    ).rejects.toThrow('runtime_unreachable')

    expect(getStoredSettings().workItemStartPromptDelivery).toBe(before)
  })

  it('drops a host answer that arrived after the active host changed', async () => {
    // The fence guarded only `worktreeVisibilityDefaults`. Switching hosts mid-flight made
    // the client apply host A's answer as if it were host B's — and for a setting the host
    // enforces, believing the wrong host's value is the same divergence by another route.
    vi.resetModules()
    let activeId = 'env-1'
    vi.doMock('./web-runtime-session', () => ({
      requireActiveEnvironmentOrNull: () => ({ id: activeId }),
      webRuntimeState: {
        worktreeVisibilityDefaultsRuntimeEnvironmentId: null,
        worktreeVisibilityDefaultsRuntimeValue: null
      }
    }))
    const { getRuntimeBackedStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockImplementation(async () => {
      activeId = 'env-2'
      return { settings: { workItemStartPromptDelivery: 'submit-after-ready' } }
    })

    const settings = await getRuntimeBackedStoredSettings()

    expect(settings.workItemStartPromptDelivery).not.toBe('submit-after-ready')
    vi.doUnmock('./web-runtime-session')
    vi.resetModules()
  })

  it('forwards a change to the host rather than keeping it local', async () => {
    const { syncRuntimeBackedSettings, getStoredSettings } = await import('./web-preferences-store')
    callRuntimeResult.mockResolvedValue({ settings: {} })

    await syncRuntimeBackedSettings(
      { workItemStartPromptDelivery: 'submit-after-ready' },
      {
        ...getStoredSettings(),
        workItemStartPromptDelivery: 'submit-after-ready'
      }
    )

    const update = callRuntimeResult.mock.calls.find(([method]) => method === 'settings.update')
    expect(update?.[1]).toMatchObject({ workItemStartPromptDelivery: 'submit-after-ready' })
  })
})
