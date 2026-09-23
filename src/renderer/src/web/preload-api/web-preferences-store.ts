import type { PreloadApi } from '../../../../preload/api-types'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../../shared/auto-rename-branch-from-work-settings'
import {
  getDefaultSettings,
  getDefaultUIState,
  getWorktreeCardModeProperties
} from '../../../../shared/constants'
import { normalizeWorktreeVisibilityDefaults } from '../../../../shared/external-worktree-visibility'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeOsc52ClipboardDefaultOn,
  osc52ClipboardDefaultOnOverridesPersistedOff
} from '../../../../shared/osc52-clipboard-settings'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import {
  applyPRBotAuthorOverride,
  normalizePRBotAuthorOverrides
} from '../../../../shared/pr-bot-author-overrides'
import { normalizeTerminalCursorStyleDefault } from '../../../../shared/terminal-cursor-style-settings'
import { normalizeTerminalCustomThemes } from '../../../../shared/terminal-custom-themes'
import { normalizeUiLanguage } from '../../../../shared/ui-language'
import { readStoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { mergeSettings, mergeWebUIState } from './web-preference-normalization'
import {
  hostEnforcedSettingsInUpdate,
  runtimeSettingsUpdatePayload
} from './web-runtime-settings-crossing'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull, webRuntimeState } from './web-runtime-session'
import { SETTINGS_STORAGE_KEY, UI_STORAGE_KEY, readJson, writeJson } from './web-storage'

export type WebSettingsApi = NonNullable<PreloadApi['settings']>

export function getStoredSettings(): GlobalSettings {
  webRuntimeState.activeEnvironment =
    webRuntimeState.activeEnvironment ?? readStoredWebRuntimeEnvironment()
  const defaults = getDefaultSettings('~')
  const rawStoredSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
  const stored = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
  const migratedStored = {
    ...stored,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(stored),
    ...normalizeTerminalCursorStyleDefault(stored),
    ...normalizeOsc52ClipboardDefaultOn(stored),
    terminalCustomThemes: normalizeTerminalCustomThemes(stored.terminalCustomThemes),
    uiLanguage: normalizeUiLanguage(stored.uiLanguage)
  }
  if (
    rawStoredSettings &&
    (stored.autoRenameBranchFromWork !== migratedStored.autoRenameBranchFromWork ||
      stored.autoRenameBranchFromWorkDefaultedOn !==
        migratedStored.autoRenameBranchFromWorkDefaultedOn ||
      stored.terminalCursorStyle !== migratedStored.terminalCursorStyle ||
      stored.terminalCursorStyleDefaultedToBlock !==
        migratedStored.terminalCursorStyleDefaultedToBlock ||
      // Kept even though the terminalCustomThemes reference compare below already forces
      // this branch for every stored blob: no migration should rely on that accident.
      stored.terminalAllowOsc52Clipboard !== migratedStored.terminalAllowOsc52Clipboard ||
      stored.terminalAllowOsc52ClipboardDefaultedOnForAllUsers !==
        migratedStored.terminalAllowOsc52ClipboardDefaultedOnForAllUsers ||
      stored.terminalCustomThemes !== migratedStored.terminalCustomThemes ||
      stored.uiLanguage !== migratedStored.uiLanguage)
  ) {
    try {
      const parsed = JSON.parse(rawStoredSettings) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        writeJson(SETTINGS_STORAGE_KEY, migratedStored)
        if (osc52ClipboardDefaultOnOverridesPersistedOff(stored)) {
          // Why a raw merge, not readLocalWebUIState(): that path calls back into
          // getStoredSettings(), and writing through it here would recurse.
          writeJson(UI_STORAGE_KEY, {
            ...readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {}),
            osc52ClipboardDefaultOnNoticePending: true
          })
        }
      }
    } catch {
      // Keep readJson's invalid-JSON fallback non-destructive.
    }
  }
  return mergeSettings(
    {
      ...defaults,
      floatingTerminalEnabled: false,
      rightSidebarOpenByDefault: false,
      activeRuntimeEnvironmentId: null
    },
    migratedStored
  )
}

export function writeStoredSettings(
  settings: GlobalSettings,
  explicitActiveRuntimeEnvironmentId?: string | null
): void {
  const durable = { ...settings }
  if (explicitActiveRuntimeEnvironmentId !== undefined) {
    durable.activeRuntimeEnvironmentId = explicitActiveRuntimeEnvironmentId
  } else {
    const stored = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
    if (Object.hasOwn(stored, 'activeRuntimeEnvironmentId')) {
      durable.activeRuntimeEnvironmentId = stored.activeRuntimeEnvironmentId ?? null
    } else {
      delete durable.activeRuntimeEnvironmentId
    }
  }
  writeJson(SETTINGS_STORAGE_KEY, durable)
}

export async function getRuntimeBackedStoredSettings(): Promise<GlobalSettings> {
  const local = getStoredSettings()
  const requestedEnvironment = requireActiveEnvironmentOrNull()
  if (!requestedEnvironment) {
    return local
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.get',
      undefined,
      15_000
    )
    const runtimeSettings: Partial<GlobalSettings> = {}
    const currentEnvironment = requireActiveEnvironmentOrNull()
    if (currentEnvironment && currentEnvironment.id !== requestedEnvironment.id) {
      // The active host CHANGED while this read was in flight, so the answer describes a
      // host this client is no longer talking to. The fence used to guard only the
      // visibility defaults; every other mirrored field was applied anyway — including the
      // one the host enforces, which is how a client came to believe host B had asked for a
      // route host B then refuses.
      //
      // Removal is not that case and keeps its existing behaviour: with no active host
      // there is no other host to misattribute the answer to, and discarding a completed
      // merge would lose settings for no safety gain.
      return local
    }
    {
      const visibilityDefaults = normalizeWorktreeVisibilityDefaults(
        result.settings.worktreeVisibilityDefaults
      )
      webRuntimeState.worktreeVisibilityDefaultsRuntimeEnvironmentId = visibilityDefaults
        ? requestedEnvironment.id
        : null
      webRuntimeState.worktreeVisibilityDefaultsRuntimeValue = visibilityDefaults ?? null
    }
    if (typeof result.settings.experimentalNewWorktreeCardStyle === 'boolean') {
      runtimeSettings.experimentalNewWorktreeCardStyle =
        result.settings.experimentalNewWorktreeCardStyle
    }
    if (typeof result.settings.compactWorktreeCards === 'boolean') {
      runtimeSettings.compactWorktreeCards = result.settings.compactWorktreeCards
    }
    if (typeof result.settings.minimaxGroupId === 'string') {
      runtimeSettings.minimaxGroupId = result.settings.minimaxGroupId
    }
    if (typeof result.settings.minimaxUsageModels === 'string') {
      runtimeSettings.minimaxUsageModels = result.settings.minimaxUsageModels
    }
    if (
      result.settings.minimaxEndpoint === 'overseas' ||
      result.settings.minimaxEndpoint === 'cn'
    ) {
      runtimeSettings.minimaxEndpoint = result.settings.minimaxEndpoint
    }
    if (Array.isArray(result.settings.prBotAuthorOverrides)) {
      runtimeSettings.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
        result.settings.prBotAuthorOverrides
      )
    }
    // Read-only mirror: the host owns this capability and `syncRuntimeBackedSettings` never
    // sends it back, so web shows what the host enforces instead of a local value it ignores.
    if (typeof result.settings.artifactSharingEnabled === 'boolean') {
      runtimeSettings.artifactSharingEnabled = result.settings.artifactSharingEnabled
    }
    if (typeof result.settings.agentSkillSharingEnabled === 'boolean') {
      runtimeSettings.agentSkillSharingEnabled = result.settings.agentSkillSharingEnabled
    }
    // The host decides whether a Work Item Start is structured, so the client has to read
    // the host's value rather than its own. Left unmirrored, the two disagree in both
    // directions and both are broken: a host on `submit-after-ready` still gets the legacy
    // terminal Start from here, and a client that sets it locally drops the terminal
    // startup for a session the host then refuses — a workspace with no writer at all.
    if (
      result.settings.workItemStartPromptDelivery === 'submit-after-ready' ||
      result.settings.workItemStartPromptDelivery === 'draft'
    ) {
      runtimeSettings.workItemStartPromptDelivery = result.settings.workItemStartPromptDelivery
    }
    const next = mergeSettings(local, runtimeSettings)
    writeStoredSettings(next)
    return settingsForActiveVisibilityOwner(next)
  } catch {
    // Why: unpaired/offline web clients keep a local settings fallback.
    return settingsForActiveVisibilityOwner(local)
  }
}

export function settingsForActiveVisibilityOwner(settings: GlobalSettings): GlobalSettings {
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return settings
  }
  if (
    environment.id === webRuntimeState.worktreeVisibilityDefaultsRuntimeEnvironmentId &&
    webRuntimeState.worktreeVisibilityDefaultsRuntimeValue
  ) {
    return {
      ...settings,
      worktreeVisibilityDefaults: webRuntimeState.worktreeVisibilityDefaultsRuntimeValue
    }
  }
  const { worktreeVisibilityDefaults: _unsupported, ...supportedSettings } = settings
  return supportedSettings as GlobalSettings
}

export async function syncRuntimeBackedSettings(
  updates: Partial<GlobalSettings>,
  localNext: GlobalSettings
): Promise<GlobalSettings> {
  const requestedEnvironment = requireActiveEnvironmentOrNull()
  if (!requestedEnvironment) {
    return localNext
  }
  const runtimeUpdates = runtimeSettingsUpdatePayload(updates)
  const visibilityDefaults = runtimeUpdates.worktreeVisibilityDefaults ?? null
  if (Object.keys(runtimeUpdates).length === 0) {
    return localNext
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.update',
      runtimeUpdates,
      15_000
    )
    const runtimeSettings = { ...result.settings }
    delete runtimeSettings.activeRuntimeEnvironmentId
    const updatedVisibilityDefaults = normalizeWorktreeVisibilityDefaults(
      runtimeSettings.worktreeVisibilityDefaults
    )
    if (
      requireActiveEnvironmentOrNull()?.id === requestedEnvironment.id &&
      updatedVisibilityDefaults
    ) {
      webRuntimeState.worktreeVisibilityDefaultsRuntimeEnvironmentId = requestedEnvironment.id
      webRuntimeState.worktreeVisibilityDefaultsRuntimeValue = updatedVisibilityDefaults
    }
    delete runtimeSettings.worktreeVisibilityDefaults
    const next = mergeSettings(localNext, runtimeSettings)
    writeStoredSettings(next)
    return next
  } catch (error) {
    // A setting the HOST enforces must never be reported as saved when the host did not take
    // it. Swallowing one leaves the client believing `submit-after-ready` while the host still
    // answers `draft`: the next Work Item Start takes the strict route, drops the terminal
    // startup, and is then definitively refused — a workspace with no writer, which is the
    // failure this whole path exists to remove.
    if (visibilityDefaults || hostEnforcedSettingsInUpdate(updates).length > 0) {
      throw error
    }
    // Why: unpaired/offline web clients still need local settings persistence.
    return localNext
  }
}

export async function updateRuntimePRBotAuthorOverride(args: {
  author: string
  isBot: boolean
}): Promise<GlobalSettings> {
  const local = getStoredSettings()
  if (requireActiveEnvironmentOrNull()) {
    // Why: don't report a successful mark the authoritative runtime failed to persist and will later overwrite.
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.updatePRBotAuthorOverride',
      args,
      15_000
    )
    const next = mergeSettings(local, {
      prBotAuthorOverrides: normalizePRBotAuthorOverrides(result.settings.prBotAuthorOverrides)
    })
    writeStoredSettings(next)
    return next
  }
  const next = mergeSettings(local, {
    prBotAuthorOverrides: applyPRBotAuthorOverride(
      local.prBotAuthorOverrides,
      args.author,
      args.isBot
    )
  })
  writeStoredSettings(next)
  return next
}

export function readLocalWebUIState(): PersistedUIState {
  const defaults = getDefaultUIState()
  // Why settings first: getStoredSettings() runs the OSC 52 migration, which writes the
  // notice arm into UI_STORAGE_KEY. Reading before it would snapshot a pre-arm state that
  // every caller then writes back, erasing the arm the stamp can never raise again.
  const storedSettings = getStoredSettings()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  const base = {
    ...defaults,
    // Why: mirror the main-process missing-property seed from legacy card layout mode when runtime ui.get is unavailable.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, stored)
  }
  return mergeWebUIState(base, {
    ...stored,
    // Why: web fallback lacks main-process normalization; migrate the retired setting only when local UI preference is absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}
