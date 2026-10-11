import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import type { RuntimeTerminalPromptDelivery } from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type {
  AgentPromptTurnStartEvidence,
  AgentPromptWaitTextCache
} from './agent-prompt-submission-verification'
import { verifyAgentPromptSubmission } from './agent-prompt-submission-verification'
import { AgentPromptRequestCorrelation } from './agent-prompt-request-correlation'
import { createHash } from 'node:crypto'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { MutationCurrentBindingSnapshot } from '../../shared/orchestration-mutation-request'

export class OrcaRuntimeWithAgentPromptRequestCorrelation extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  private readonly agentPromptCorrelation = new AgentPromptRequestCorrelation()
  // Declared, not defined: both live further up the mixin chain, so this link cannot see them.
  declare protected getLivePtyForHandle: (
    handle: string
  ) => { record: TerminalHandleRecord; pty: RuntimePtyWorktreeRecord } | null
  declare protected getLiveLeafForHandle: (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }

  getTerminalPromptRequestBinding(handle: string): {
    ptyId: string
    processIncarnation: string
    generation: number
  } {
    const live = this.getLivePtyForHandle(handle)
    const ptyId = live?.pty.ptyId ?? this.getLiveLeafForHandle(handle).leaf.ptyId
    if (!ptyId) {
      throw new Error('terminal_not_writable')
    }
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(ptyId)?.incarnationId
    return {
      ptyId,
      processIncarnation: incarnationId ?? `${this.runtimeId}:${ptyId}:${generation}`,
      generation
    }
  }

  getTerminalPromptCurrentBinding(
    handle: string,
    observedAfter: number
  ): MutationCurrentBindingSnapshot | null {
    const live = this.getLivePtyForHandle(handle)
    const pty = live?.pty
    if (
      !pty?.connected ||
      !pty.paneKey ||
      !pty.incarnationId ||
      !pty.launchToken ||
      pty.launchIncarnationId !== pty.incarnationId
    ) {
      return null
    }
    const binding = this.getTerminalPromptRequestBinding(handle)
    const session = selectExactWorkerProviderSession({
      paneKey: pty.paneKey,
      processIncarnation: binding.processIncarnation,
      connectionId: pty.connectionId,
      launchToken: pty.launchToken,
      wslDistro: pty.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(pty.ptyId) ?? pty.wslDistro),
      observedAfter,
      statuses: this.getAgentStatusSnapshotFn?.() ?? [],
      requireUniqueLiveBinding: true
    })
    if (!session || session.connectionId === undefined) {
      return null
    }
    return {
      terminal: handle,
      ...binding,
      paneKey: session.paneKey,
      connectionId: session.connectionId,
      launchTokenHash: createHash('sha256').update(pty.launchToken).digest('hex'),
      provider: session.agent,
      providerSession: session.providerSession,
      observedAt: session.observedAt
    }
  }

  async observeTerminalAgentPrompt(
    handle: string,
    prompt: RuntimeTerminalPromptDelivery,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RuntimeTerminalPromptDelivery> {
    const binding = this.getTerminalPromptRequestBinding(handle)
    if (
      binding.processIncarnation !== prompt.processIncarnation ||
      binding.generation !== prompt.generation
    ) {
      return { ...prompt, observation: 'incarnation_replaced' }
    }
    const waitTextCache: AgentPromptWaitTextCache = {}
    const baseline = this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache)
    try {
      await verifyAgentPromptSubmission({
        baseline: {
          ...baseline,
          workingSequence: prompt.baselineWorkingSequence,
          ...(prompt.baselinePermissionSequence !== undefined
            ? { permissionSequence: prompt.baselinePermissionSequence }
            : {}),
          ...(prompt.baselineExplicitWorkingStartedAt !== undefined
            ? { explicitWorkingStartedAt: prompt.baselineExplicitWorkingStartedAt }
            : {})
        },
        readActivity: () => this.getAgentPromptActivity(handle, binding.ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            binding.ptyId,
            binding.generation,
            prompt.requestId,
            prompt.baselineWorkingSequence,
            prompt.baselineExplicitWorkingStartedAt ?? null,
            evidence
          ),
        // Old hosts omit the hook baseline, so their receipts retain title-only observation.
        allowHookEvidence: prompt.baselineExplicitWorkingStartedAt !== undefined,
        allowOutputEvidence: false,
        signal,
        timeoutMs
      })
      this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
      return { ...prompt, stages: ['input_accepted', 'turn_started'], observation: 'supported' }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return prompt
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(binding.ptyId, binding.generation, prompt.requestId)
        return { ...prompt, observation: 'permission' }
      }
      throw error
    }
  }

  protected registerAgentPromptRequest(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null
  ): void {
    this.agentPromptCorrelation.register(ptyId, {
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt
    })
  }

  protected forgetAgentPromptRequest(ptyId: string, generation: number, requestId: string): void {
    this.agentPromptCorrelation.forget(ptyId, generation, requestId)
  }

  protected acceptAgentPromptTurnStart(
    ptyId: string,
    generation: number,
    requestId: string,
    baselineWorkingSequence: number,
    baselineExplicitWorkingStartedAt: number | null,
    evidence: AgentPromptTurnStartEvidence
  ): boolean {
    return this.agentPromptCorrelation.acceptTurnStart(
      ptyId,
      generation,
      requestId,
      baselineWorkingSequence,
      baselineExplicitWorkingStartedAt,
      evidence
    )
  }

  protected clearAgentPromptCorrelationForPty(ptyId: string): void {
    this.agentPromptCorrelation.clearForPty(ptyId)
  }
}
