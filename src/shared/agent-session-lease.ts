/** Still persisted because older builds read it. The removed terminal handoff's `tui` is mapped
 *  away at decode (agent-session-legacy-handoff-lease). */
export type AgentSessionOwnerRuntimeKind = 'native'

/** The acquisition stage. Stages only older builds wrote are mapped away at decode. */
export type AgentSessionHandoffStage = 'new-owner-proving' | 'recovering'

/** Use spawnToken across platforms; start time requires Windows CIM and is unavailable in some containers. */
export type AgentSessionProcessIdentity = {
  hostId: string
  pid: number
  processStartTimeMs: number | null
  spawnToken: string
  /** The Orca runtime that started this process and holds its transport, stamped when the owner is
   *  recorded; absent on owners older builds recorded. */
  runtime?: string
}

/** released has no owner; conflicted retains a legacy terminal owner that recovery waits for and never stops because it is the user's agent. */
export type AgentSessionClaimStatus = 'reserved' | 'live' | 'conflicted' | 'released'

export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'kill-delivered' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
  /** Fence of the owner (or reservation) this death is about; a fence names exactly one. Absent on
   *  evidence older builds wrote, which then speaks for no turn. */
  ownerFence?: number
  /** Last liveness proof by the transport holder; absent for surface release, failed start or older evidence. */
  lastProvenAliveAt?: number
  /** Quit/update/crash when the provider died with its runtime; absent for independent/unknown death. Keep open strings and read with isAgentSessionOrcaStopCause. */
  runtimeEnd?: string
}

export type AgentSessionLease = {
  sessionId: string
  runtimeKind: AgentSessionOwnerRuntimeKind
  /** Durable monotonic integer; only acquisition CAS and proven eviction move it. */
  runtimeFence: number
  handoffStage: AgentSessionHandoffStage | null
  /** Link id of the provider handle this owner proved; the full chain lives on the record. */
  provenHandleLinkId: string | null
  /** Null between the durable reservation and the observed spawn. */
  ownerProcess: AgentSessionProcessIdentity | null
  /** Reserved before any process exists, then matched against the child's environment. */
  reservedSpawnToken: string | null
  leaseDeadlineAt: number
  /** While `ownerProcess` is set, the last time its transport holder proved it alive; parking in
   *  `recovering` proves nothing, so it leaves this alone. */
  lastRenewedAt: number
  handoffOperationId: string | null
  /** Key id that minted the HMAC claim this lease was granted under. */
  claimKeyId: string
  claimStatus: AgentSessionClaimStatus
  /** True from load until the host adjudicates it; no writer is granted while set. */
  unreconciled: boolean
  /** Imported backup/set-aside copies may hide a granted fence: floor future grants, preserving the current fence required by proven live handles. */
  minimumNextFence?: number
  /** Null on a released lease when nothing proved its owner gone. */
  deathEvidence: AgentSessionDeathEvidence | null
}
