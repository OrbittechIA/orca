import type { PreloadApi } from '../../../../preload/api-types'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../../../shared/computer-awake-mode'
import { normalizeTerminalCursorStyleDefault } from '../../../../shared/terminal-cursor-style-settings'
import { HOST_ENFORCED_SETTING_KEYS } from './web-runtime-settings-crossing'
import { mergeSettings } from './web-preference-normalization'
import {
  getRuntimeBackedStoredSettings,
  getStoredSettings,
  settingsForActiveVisibilityOwner,
  syncRuntimeBackedSettings,
  updateRuntimePRBotAuthorOverride,
  writeStoredSettings
} from './web-preferences-store'
import type { WebSettingsApi } from './web-preferences-store'
import {
  requireActiveEnvironmentOrNull,
  resolveEnvironment,
  webRuntimeState
} from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'

export function createWebSettingsApi(): Partial<PreloadApi> {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the web preload implements the subset of the settings API the web client calls; `satisfies Partial<WebSettingsApi>` type-checks every member it does implement, and the unimplemented ones are never reached from the web renderer.
    settings: {
      get: async () => getRuntimeBackedStoredSettings(),
      // Why: localStorage-backed settings are synchronous, so the pre-hydration kill-switch read works the same as desktop.
      getSync: () => settingsForActiveVisibilityOwner(getStoredSettings()),
      set: async (updates) => {
        const sanitizedUpdates = { ...updates }
        const runtimeEnvironment = requireActiveEnvironmentOrNull()
        delete sanitizedUpdates.activeRuntimeEnvironmentId
        if (
          'worktreeVisibilityDefaults' in sanitizedUpdates &&
          runtimeEnvironment &&
          runtimeEnvironment.id !== webRuntimeState.worktreeVisibilityDefaultsRuntimeEnvironmentId
        ) {
          delete sanitizedUpdates.worktreeVisibilityDefaults
        }
        if ('worktreeVisibilityDefaults' in sanitizedUpdates) {
          sanitizedUpdates.worktreeVisibilityDefaults = {
            ...settingsForActiveVisibilityOwner(getStoredSettings()).worktreeVisibilityDefaults,
            ...sanitizedUpdates.worktreeVisibilityDefaults
          }
        }
        if ('computerAwakeMode' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            computerAwakeSettingsForMode(
              normalizeComputerAwakeMode(
                sanitizedUpdates.computerAwakeMode,
                sanitizedUpdates.keepComputerAwakeWhileAgentsRun
              )
            )
          )
        } else if ('keepComputerAwakeWhileAgentsRun' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            computerAwakeSettingsForMode(
              sanitizedUpdates.keepComputerAwakeWhileAgentsRun ? 'auto' : 'off'
            )
          )
        }
        if ('autoRenameBranchFromWorkDefaultedOn' in sanitizedUpdates) {
          sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
        }
        if ('terminalCursorStyle' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            normalizeTerminalCursorStyleDefault(
              { terminalCursorStyle: sanitizedUpdates.terminalCursorStyle },
              { preserveExplicitValue: true }
            )
          )
        }
        const localUpdates = { ...sanitizedUpdates }
        if (runtimeEnvironment) {
          delete localUpdates.worktreeVisibilityDefaults
        }
        const previous = getStoredSettings()
        const next = mergeSettings(previous, localUpdates, {
          preserveAutoRenameBranchFromWorkUpdate: 'autoRenameBranchFromWork' in sanitizedUpdates
        })
        writeStoredSettings(next)
        try {
          return settingsForActiveVisibilityOwner(
            await syncRuntimeBackedSettings(sanitizedUpdates, next)
          )
        } catch (error) {
          // The optimistic write has to come back out — but only for the settings the HOST
          // owns. Leaving the local copy ahead of the host on one of those is the divergence
          // that makes a Work Item Start drop its terminal startup for a session the host
          // then refuses. Local-only fields in the same update were never the host's to
          // accept, so rolling those back too would discard a change nothing rejected.
          const restored = { ...next }
          for (const key of HOST_ENFORCED_SETTING_KEYS) {
            restored[key] = previous[key]
          }
          writeStoredSettings(restored)
          throw error
        }
      },
      setActiveRuntimeEnvironmentPreference: async ({ environmentId }) => {
        const requestedEnvironmentId = environmentId?.trim() || null
        const activeRuntimeEnvironmentId = requestedEnvironmentId
          ? resolveEnvironment(requestedEnvironmentId).id
          : null
        const next = mergeSettings(getStoredSettings(), {
          activeRuntimeEnvironmentId
        })
        writeStoredSettings(next, activeRuntimeEnvironmentId)
        return next
      },
      updatePRBotAuthorOverride: (args) => updateRuntimePRBotAuthorOverride(args),
      listFonts: () => Promise.resolve([]),
      onChanged: () => noopUnsubscribe
    } satisfies Partial<WebSettingsApi> as unknown as WebSettingsApi,
    agentAwake: {
      getStatus: async () => {
        const settings = getStoredSettings()
        return {
          mode: normalizeComputerAwakeMode(
            settings.computerAwakeMode,
            settings.keepComputerAwakeWhileAgentsRun
          ),
          active: false
        }
      },
      onChanged: () => noopUnsubscribe
    }
  }
}
