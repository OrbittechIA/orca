import type { MaterialPtyCensus, PtySpawnOptions } from '../providers/pty-provider-contract'
import { sameEndpointIdentity } from './daemon-endpoint-incarnation'
import { probeDaemonProcessIdentity } from './daemon-incarnation-evidence'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import { emitPtyListeners, createPtyExitPayload } from './daemon-pty-listener-emission'
import { basename, isAbsolute } from 'node:path'
import { existsSync } from 'node:fs'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import {
  cloneAgentSessionOwnerBinding,
  agentSessionClaimKey
} from '../../shared/claimed-agent-pty-owner-snapshot'
import { recordAuthenticatedInventory } from './daemon-audit-classifier'
import { isMissingWindowsNamedPipeError } from './daemon-endpoint-errors'
import { DaemonPtyProcessInspection } from './daemon-pty-process-inspection'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { parsePtySessionId } from './pty-session-id'
import type { ListSessionsResult, SessionInfo } from './types'
import { PtyProcessListAdmission } from '../providers/pty-process-list-admission'
import type { PtyProcessInfo } from '../providers/types'

export abstract class DaemonPtySessionInventory extends DaemonPtyProcessInspection {
  private materialSpawnEpoch = 0
  private materialSpawns = 0
  override async spawn(opts: PtySpawnOptions) {
    this.materialSpawnEpoch++
    this.materialSpawns++
    try {
      return await super.spawn(opts)
    } finally {
      this.materialSpawns--
    }
  }

  async observeMaterialCensus({ deadlineMs }: { deadlineMs: number }): Promise<MaterialPtyCensus> {
    const unknown = (): MaterialPtyCensus => ({
      state: 'unverifiable',
      reason: 'daemon_census_unproven'
    })
    const epoch = this.materialSpawnEpoch
    const client = this.client
    const idle = () =>
      epoch === this.materialSpawnEpoch &&
      this.materialSpawns === 0 &&
      this.pendingSpawnOperationsBySessionId.size === 0 &&
      this.pendingClaimSpawnOperations.size === 0 &&
      !this.respawnPromise &&
      !this.staleBundleReplacementPromise &&
      !this.writeRecoveryPromise &&
      client === this.client
    if (!idle() || Date.now() >= deadlineMs) {
      return unknown()
    }
    try {
      if (!client.isConnected()) {
        const exact = this.exactDaemonIncarnation
        if (!exact) {
          return unknown()
        }
        const proof = await probeDaemonProcessIdentity(exact, {
          socketPath: this.socketPath,
          tokenPath: this.tokenPath
        })
        const stillCurrent = () =>
          idle() && !client.isConnected() && exact === this.exactDaemonIncarnation
        return proof.state === 'gone' && stillCurrent() && Date.now() < deadlineMs
          ? { state: 'complete', processes: [], stillCurrent }
          : unknown()
      }
      const identity = client.getDaemonIdentity()
      if (
        !identity ||
        !this.lastAuthenticatedIdentity ||
        !sameEndpointIdentity(identity, this.lastAuthenticatedIdentity)
      ) {
        return unknown()
      }
      const stillCurrent = () => {
        const current = client.getDaemonIdentity()
        return (
          idle() && client.isConnected() && !!current && sameEndpointIdentity(identity, current)
        )
      }
      const result = await client.request<ListSessionsResult>(
        'listSessions',
        undefined,
        Math.min(5000, Math.max(1, deadlineMs - Date.now()))
      )
      if (
        !stillCurrent() ||
        !Array.isArray(result.sessions) ||
        result.sessions.length > 20_000 ||
        Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024
      ) {
        return unknown()
      }
      const admission = new PtyProcessListAdmission()
      const processes: PtyProcessInfo[] = []
      const ids = new Set<string>()
      const claims = new Set<string>()
      for (const session of result.sessions) {
        if (
          !session ||
          typeof session.sessionId !== 'string' ||
          ids.has(session.sessionId) ||
          session.isAlive !== true ||
          !['created', 'spawning', 'running', 'exiting'].includes(session.state) ||
          !Number.isSafeInteger(session.pid) ||
          !session.pid ||
          session.pid < 1 ||
          session.wslDistro !== null ||
          !isPtyIncarnationId(session.incarnationId) ||
          typeof session.cwd !== 'string' ||
          !isAbsolute(session.cwd) ||
          !Array.isArray(session.agentSessionOwners) ||
          session.agentSessionOwners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES ||
          !session.agentSessionOwners.every(
            (owner) =>
              isAgentSessionOwnerBinding(owner) &&
              owner.phase === 'live' &&
              owner.ptyId === session.sessionId
          )
        ) {
          return unknown()
        }
        ids.add(session.sessionId)
        for (const owner of session.agentSessionOwners) {
          const key = agentSessionClaimKey(owner.claim)
          if (claims.has(key)) {
            return unknown()
          }
          claims.add(key)
        }
        const { worktreeId } = parsePtySessionId(session.sessionId)
        processes.push(
          admission.admit({
            id: session.sessionId,
            incarnationId: session.incarnationId,
            cwd: session.cwd,
            rootProcessId: session.pid,
            title: 'shell',
            ...(worktreeId ? { worktreeId } : {}),
            ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
            agentSessionOwners: session.agentSessionOwners.map(cloneAgentSessionOwnerBinding),
            ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {})
          })
        )
      }
      return { state: 'complete', processes, stillCurrent }
    } catch {
      return unknown()
    }
  }

  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    // Why: snapshotted before the request so ids spawned mid-flight can never
    // be reconciled away below.
    const preRequestActiveIds = new Set(this.activeSessionIds)
    try {
      // Why retry: this inventory is what destructive teardown consults, and a
      // dead host pipe surfaced as `connect ENOENT \\?\\pipe\\orca-terminal-host-...`
      // that failed worktree removal until the app was restarted (#10087). Spawn
      // already recovered from exactly this; inventory did not, so the one path
      // that must not get stuck was the only one that could not heal.
      //
      // Why the request is inside too: a host that dies between connect and
      // listSessions throws the same daemon-gone error, so retrying only the
      // connect would still fail. The reconciliation below stays outside --
      // retrying that would double-apply it.
      //
      // Why: connect + listSessions share the caller's one absolute deadline so a
      // wedged handshake cannot burn the whole teardown budget before the list issues.
      const result = await this.withDaemonRetry(async () => {
        await this.ensureConnected(opts?.deadlineMs)
        return this.client.request<ListSessionsResult>(
          'listSessions',
          undefined,
          remainingDaemonRequestTimeoutMs(opts?.deadlineMs)
        )
      })
      const admission = new PtyProcessListAdmission()
      const processes: PtyProcessInfo[] = []
      const aliveSessionIds = new Set<string>()
      for (const session of result.sessions) {
        if (!session.isAlive) {
          continue
        }
        aliveSessionIds.add(session.sessionId)
        const { worktreeId } = parsePtySessionId(session.sessionId)
        processes.push(
          admission.admit({
            id: session.sessionId,
            ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
            ...(session.pid ? { rootProcessId: session.pid } : {}),
            // Why: OSC 7 may not arrive before cleanup; spawn cwd is authoritative until the daemon reports a live cwd.
            cwd: session.cwd ?? this.initialCwds.get(session.sessionId) ?? '',
            title: 'shell',
            ...(worktreeId ? { worktreeId } : {}),
            ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
            ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {}),
            ...(session.state === 'exiting' ? { exiting: true as const } : {}),
            ...this.validatedAgentSessionOwners(session.agentSessionOwners)
          })
        )
      }
      // Why: hasPty reads activeSessionIds, and an exit missed while the socket
      // was disconnected otherwise survives an authoritative inventory forever —
      // defeating every absence proof built on the cache.
      for (const id of preRequestActiveIds) {
        if (!aliveSessionIds.has(id)) {
          this.activeSessionIds.delete(id)
        }
      }
      this.publishAuditObservation(
        recordAuthenticatedInventory(this.auditContext, this.exactDaemonIncarnation)
      )
      return processes
    } catch (error) {
      const missingAuthenticatedToken = this.isRetiredEndpointTokenMissing()
      const missingNamedPipe = isMissingWindowsNamedPipeError(error)
      this.observeAuditFailure(
        missingAuthenticatedToken
          ? 'token_missing_after_authenticated_disconnect'
          : 'inventory_failed',
        this.exactDaemonIncarnation,
        [
          ...(missingAuthenticatedToken ? (['token_file'] as const) : []),
          ...(missingNamedPipe ? (['windows_named_pipe'] as const) : [])
        ],
        missingNamedPipe ? 'windows_named_pipe_missing' : undefined
      )
      throw error
    }
  }

  protected validatedAgentSessionOwners(
    owners: unknown
  ): { agentSessionOwners: AgentSessionOwnerBinding[] } | Record<string, never> {
    if (owners === undefined) {
      return {}
    }
    if (
      !Array.isArray(owners) ||
      owners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES ||
      !owners.every((owner) => isAgentSessionOwnerBinding(owner) && owner.phase === 'live')
    ) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owners.length > 0
      ? { agentSessionOwners: owners.map(cloneAgentSessionOwnerBinding) }
      : {}
  }

  // Why: the Manage Sessions panel needs the full SessionInfo (pid, state,
  // createdAt) per session for display; listProcesses drops that detail for
  // the IPtyProvider contract. Keep both in parallel rather than widening
  // the provider surface.
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions
      .filter((s) => s.isAlive)
      .map((session) => ({
        ...session,
        ...this.validatedAgentSessionOwners(session.agentSessionOwners)
      }))
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  // Why: the daemon's kill-all-and-shutdown path suppresses onExit fanout (session.ts:246-252), so synthesize pty:exit
  // for every live session before teardown or renderer panes black-hole writes to a disposed adapter forever.
  fanoutSyntheticExits(code: number): void {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.stopCheckpointTimer()
    for (const id of ids) {
      this.coldRestoreCache.delete(id)
      // Why: don't catch listener throws — matches the natural onExit fanout so synthetic exits keep the same error semantics.
      emitPtyListeners(this.exitListeners, (listener) =>
        listener(
          createPtyExitPayload(id, { code, incarnationId: this.sessionIncarnations.get(id) })
        )
      )
      this.sessionIncarnations.delete(id)
    }
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }
}
