// `settings.update` carries the Work Item Start prompt-delivery choice paired web clients send.
// Runs the real dispatcher, strict params schema and settings controller over an in-memory store.

import { describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeClientSettingsController } from '../../runtime-client-settings'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

const PAIRED = { clientKind: 'runtime' as const, clientCapabilities: [], pairedDeviceId: 'web-1' }

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'settings.update', params }
}

function harness() {
  let settings: GlobalSettings = createGlobalSettingsFixture({ workspaceDir: '/w' })
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller's get/update paths read only getSettings and updateSettings.
  const controller = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.update and settings.get reach only these three runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => controller.get(),
    updateClientSettings: vi.fn((updates) => controller.update(updates))
  } as unknown as OrcaRuntimeService
  return {
    runtime,
    updateSettings,
    dispatcher: new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  }
}

describe('settings.update workItemStartPromptDelivery', () => {
  it.each(['submit-after-ready', 'draft'] as const)(
    'persists %s from a paired client and reads it back',
    async (value) => {
      const { dispatcher, runtime } = harness()

      const response = await dispatcher.dispatch(
        makeRequest({ workItemStartPromptDelivery: value }),
        PAIRED
      )

      expect(response).toMatchObject({
        ok: true,
        result: { settings: { workItemStartPromptDelivery: value } }
      })
      expect(runtime.updateClientSettings).toHaveBeenCalledWith({
        workItemStartPromptDelivery: value
      })
      expect(runtime.getClientSettings().workItemStartPromptDelivery).toBe(value)
    }
  )

  it('refuses an unknown value without touching the store', async () => {
    const { dispatcher, runtime, updateSettings } = harness()

    const response = await dispatcher.dispatch(
      makeRequest({ workItemStartPromptDelivery: 'auto-submit' }),
      PAIRED
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateClientSettings).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('leaves a legacy payload that omits the key unchanged', async () => {
    const { dispatcher, runtime } = harness()
    const before = runtime.getClientSettings().workItemStartPromptDelivery

    const response = await dispatcher.dispatch(makeRequest({ compactWorktreeCards: true }), PAIRED)

    expect(response).toMatchObject({ ok: true })
    expect(runtime.updateClientSettings).toHaveBeenCalledWith({ compactWorktreeCards: true })
    expect(runtime.getClientSettings().workItemStartPromptDelivery).toBe(before)
  })

  it('still refuses the host-owned structured chat setting alongside it', async () => {
    const { dispatcher, runtime } = harness()

    const response = await dispatcher.dispatch(
      makeRequest({
        workItemStartPromptDelivery: 'draft',
        experimentalStructuredNativeChat: true
      }),
      PAIRED
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(runtime.updateClientSettings).not.toHaveBeenCalled()
  })
})
