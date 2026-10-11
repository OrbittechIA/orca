import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { TerminalCreateOptions } from './orca-runtime-create-terminal-dependencies'
import type { Worktree } from '../../shared/worktree/types'
import { restoreMaterialGit } from './runtime-worktree-material-git'
import { MaterialRestoredReceipt } from '../../shared/rpc-contract/worktree-material-params'
import {
  materialAdmissionContext,
  withMaterialAdmission,
  withMaterialRestoreAdmission,
  type MaterialAdmissionHold,
  type MaterialAdmissionAuthority
} from './runtime-worktree-material-admission'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import {
  planWorktreeMaterial,
  inspectWorktreeMaterial,
  observeMaterialProcessAbsence,
  materialAuthorityFence,
  type MaterialAuthority
} from './runtime-worktree-material'
import type { MaterialManifest } from '../../shared/worktree/material-types'
import { installRuntimeLinearCommandSurface } from './runtime-linear-command-surface'
import { OrcaRuntimeWithMigrationCatalog } from './orca-runtime-migration-catalog'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import type {
  AgentLaunchPaneAddress,
  AgentLaunchPaneVerdict
} from '../../shared/agent-launch-pane-verdict'
import { registerWorktreeChangeInvalidator } from '../ipc/worktree-change-invalidators'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { peekOpenedAgentSessionRecordStore } from './agent-session-record-store-slot'
import { createAgentLaunchRecordWarmupGate } from './agent-launch-record-warmup-gate'
import { registerDetectedWorktreeScanInvalidation } from '../ipc/worktrees/listing/register-detected-worktree-scan-invalidation'

class OrcaRuntimeService extends OrcaRuntimeWithMigrationCatalog {
  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithMigrationCatalog>) {
    super(...args)
    // Why: the runtime listing re-runs a scan the worktree-change generation overtook and re-lists
    // through this runtime's scan cache, so a worktree change must reach both. The desktop IPC
    // module registers the generation bump at load; a headless host never loads it.
    registerDetectedWorktreeScanInvalidation()
    registerWorktreeChangeInvalidator((repoId) => this.invalidateWorktreeCatalog(repoId))
  }

  readonly materialAdmissionAuthority: MaterialAdmissionAuthority = {
    getExistingDb: () => this.getOrchestrationDbIfAvailable(),
    readPendingClaims: () => {
      const opened = this.getOrchestrationDbIfAvailable()
      if (opened) {
        return opened.readPendingMaterialClaims()
      }
      try {
        lstatSync(join(getAppEnvironment().getPath('userData'), 'orchestration.db'))
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return []
        }
        throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE: claim_path_unverifiable')
      }
      // Opening even readOnly SQLite may touch WAL sidecars. Use the normal owner's open handle.
      throw new Error('E_MATERIAL_ADMISSION_UNVERIFIABLE: cold_claim_reader_unavailable')
    },
    captureCensus: (id) => this.store?.captureLocalWorktreeMaterialCensus?.(id) ?? null
  }

  override createManagedWorktree(args: RuntimeManagedWorktreeCreateArgs) {
    return withMaterialAdmission(this.materialAdmissionAuthority, { creatingWorktree: true }, () =>
      super.createManagedWorktree(
        Object.assign({}, args, { [materialAdmissionContext]: this.materialAdmissionAuthority })
      )
    )
  }

  override createTerminal(selector?: string, opts: TerminalCreateOptions = {}, created?: Worktree) {
    const observedSelector =
      selector ?? this.store?.getWorkspaceSession?.()?.activeWorktreeId ?? undefined
    return withMaterialAdmission(
      this.materialAdmissionAuthority,
      { selector: observedSelector, cwd: opts.cwd },
      (hold) => super.createTerminal(selector, opts, created, hold)
    )
  }

  async admitDesktopMaterial(
    selector: string | undefined,
    opts: TerminalCreateOptions,
    created: Worktree | undefined,
    material: MaterialAdmissionHold
  ) {
    // Pin the observed default workspace before asking the renderer, which otherwise selects
    // its active tab later. Its PTY entrypoint independently revalidates the final cwd as well.
    const desktopSelector =
      material.selector ??
      selector ??
      this.store?.getWorkspaceSession?.()?.activeWorktreeId ??
      undefined
    material.revalidate({ selector: desktopSelector, cwd: opts.cwd })
    const desktopWorkspace = desktopSelector
      ? await this.resolveTerminalWorkspaceLaunchScope(desktopSelector, created)
      : null
    if (desktopWorkspace) {
      material.revalidate({
        selector: desktopWorkspace.id,
        cwd:
          this.resolveWorkspaceTerminalStartupCwd(desktopWorkspace, opts.cwd) ??
          desktopWorkspace.path,
        connectionId: desktopWorkspace.connectionId
      })
    } else {
      material.revalidate()
    }
    return desktopWorkspace ? `id:${desktopWorkspace.id}` : desktopSelector
  }

  private materialAuthority(manifest: MaterialManifest): MaterialAuthority {
    return {
      repos: this.store?.getRepos() ?? [],
      census: this.store?.captureLocalWorktreeMaterialCensus?.(manifest.worktreeId) ?? null,
      observePty: this.ptyController?.observeMaterialCensus?.bind(this.ptyController),
      peekStructured: peekOpenedAgentSessionRecordStore,
      historyReadback: this.store?.supportsMaterialHistoryReadback?.() === true
    }
  }

  planMaterial(manifest: MaterialManifest) {
    return planWorktreeMaterial(this.materialAuthority(manifest), manifest)
  }

  restoreMaterial(manifest: MaterialManifest, requestId: string, markEffectPossible: () => void) {
    return withMaterialRestoreAdmission(
      this.materialAdmissionAuthority,
      manifest,
      requestId,
      async () => {
        const release = await this.holdWorktreeLifecycleExclusively(
          manifest.worktreeId,
          Date.now() + 30_000,
          'local'
        )
        try {
          const store = this.store
          const ptyController = this.ptyController
          const admitted = this.materialAuthority(manifest)
          let fence = materialAuthorityFence(admitted, manifest)
          const observed = await inspectWorktreeMaterial(admitted, manifest)
          if (
            !observed.plan.materializable ||
            !observed.repo ||
            !observed.git?.adminDigest ||
            !observed.git.indexDigest ||
            !observed.stillCurrent ||
            !store?.runDurableMutation ||
            !store.stageMaterialHistory ||
            !store.publishMaterialIdentity
          ) {
            throw new Error(observed.plan.code)
          }
          let currentProcessProof = observed.stillCurrent
          const assertMetadata = () => {
            if (this.store !== store || this.ptyController !== ptyController) {
              throw new Error('E_MATERIAL_CAS_CONFLICT')
            }
            return fence(this.materialAuthority(manifest))
          }
          const assertCurrent = async () => {
            const proof = await observeMaterialProcessAbsence(assertMetadata(), manifest)
            if (!proof?.()) {
              throw new Error('E_MATERIAL_CENSUS_UNVERIFIABLE')
            }
            assertMetadata()
            currentProcessProof = proof
          }
          const assertPublication = () => {
            assertMetadata()
            if (!currentProcessProof()) {
              throw new Error('E_MATERIAL_CENSUS_UNVERIFIABLE')
            }
          }
          await restoreMaterialGit(
            observed.repo.path,
            manifest,
            observed.git,
            markEffectPossible,
            assertCurrent
          )
          const history = await store.runDurableMutation(
            () => {
              const history = store.stageMaterialHistory!(manifest, requestId)
              fence = materialAuthorityFence(this.materialAuthority(manifest), manifest)
              assertPublication()
              return { value: history }
            },
            { revalidate: assertPublication }
          )
          await assertCurrent()
          const instanceId = await store.runDurableMutation(
            () => ({ value: store.publishMaterialIdentity!(history) }),
            { materialHistory: history, revalidate: assertPublication }
          )
          return MaterialRestoredReceipt.parse({
            schemaVersion: 1,
            state: 'restored',
            requestId,
            manifest,
            adminDigest: observed.git.adminDigest,
            indexDigest: observed.git.indexDigest,
            historyDigest: history.historyDigest,
            historicalInstanceId: manifest.historicalInstanceId,
            instanceId,
            coverage: observed.plan.coverage,
            retryAllowed: false,
            writerConfirmed: false
          })
        } finally {
          release()
        }
      }
    )
  }

  materialReceiptDb() {
    return this.getOrchestrationDbIfAvailable()
  }

  /** Whether a window owns the layout and can show a launch's tab ahead of its process. */
  canPublishAgentLaunchTab(): boolean {
    return Boolean(this.notifier?.publishAgentLaunchTab && this.getAvailableAuthoritativeWindow())
  }

  /** Shows an agent launch's tab before its process exists, in the window that owns the layout;
   *  null when no window does, and the launch's tab then appears when it spawns, as before. */
  publishAgentLaunchTab(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null {
    if (!this.notifier?.publishAgentLaunchTab || !this.getAvailableAuthoritativeWindow()) {
      return null
    }
    return this.notifier.publishAgentLaunchTab(request)
  }

  /** Tells the window a launch pane's fate: it keeps a final one on the tab, clears a settled one,
   *  and takes a withdrawn pane back (the pane alone when the user split the tab). */
  reportAgentLaunchPaneVerdict(
    pane: AgentLaunchPaneAddress,
    verdict: AgentLaunchPaneVerdict
  ): void {
    this.notifier?.agentLaunchPaneVerdict?.({ ...pane, verdict })
  }

  private readonly agentLaunchRecordWarmup = createAgentLaunchRecordWarmupGate({
    isOpen: () => peekOpenedAgentSessionRecordStore() !== null,
    open: () => this.openAgentSessionRecordStore()
  })

  /** Startup is done; the launch record may open once a client that can launch is here too. */
  noteAgentLaunchStartupSettled(): void {
    this.agentLaunchRecordWarmup.startupSettled()
  }

  /** A client that can call `agent.launch` connected; its first launch should not open the record. */
  noteAgentLaunchClientReady(): void {
    this.agentLaunchRecordWarmup.launchClientReady()
  }

  /** Whether a running process holds this pane now: such a pane is attached to, never launched into. */
  hasLiveTerminalForPaneKey(paneKey: string): boolean {
    return this.getPtyRecordForPaneKey(paneKey)?.connected === true
  }

  /** The launch record when it is already open, for a reader that must not wait for it. */
  openedAgentSessionRecordStore(): AgentSessionRecordStore | null {
    return peekOpenedAgentSessionRecordStore()
  }
}
type OrcaRuntimeServiceExport = RuntimeCommandSurfaceHost<OrcaRuntimeService>
const OrcaRuntimeServiceExport = OrcaRuntimeService as unknown as {
  new (...args: ConstructorParameters<typeof OrcaRuntimeService>): OrcaRuntimeServiceExport
  readonly prototype: OrcaRuntimeServiceExport
}
export { OrcaRuntimeServiceExport as OrcaRuntimeService }
installRuntimeLinearCommandSurface(OrcaRuntimeServiceExport.prototype)

export type { LegacyWorkerTerminalRecoveryResult } from './runtime-legacy-worker-terminal-recovery-types'
export type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-controller'
export type { SubscriptionRegistration } from './runtime-subscription-registry'
export type {
  OrchestrationCompatibilityCallerAuthority,
  OrchestrationCompatibilityTerminalAuthority,
  RuntimePtyDataAdmission,
  RuntimeTerminalAgentStatusEvent
} from './runtime-terminal-contracts'
export type { MessageWaitResult } from './runtime-message-waiters'
export type { AccountsSnapshot, CodexRateLimitResetRpcResult } from './runtime-account-controller'
export type {
  MobileNotificationDispatchEvent,
  MobileNotificationDismissEvent,
  MobileNotificationEvent
} from './runtime-mobile-notification-controller'
export type { RuntimeTerminalDataMeta } from './runtime-terminal-stream-consumers'
export type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
export {
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './terminal-wait-tail-state'
export { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
export { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-tail-redraw-buffer'
export { buildPreview } from './terminal-tail-state'
export { buildRestoredTerminalTailSeed } from './terminal-tail-restore-seed'
export { projectTerminalTailLines } from './orca-runtime-terminal-projection'
export { resolveWorktreeScanCacheTtlMs } from './runtime-worktree-scan-cache'
export type {
  RuntimeWorktreeLifecycleEvent,
  DriverState,
  PtyLayoutTarget,
  PtyLayoutState,
  ApplyLayoutResult,
  RuntimeRendererReloadFence
} from './orca-runtime-core'
export {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
} from './orca-runtime-postlude'
