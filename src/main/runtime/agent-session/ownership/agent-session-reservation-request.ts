import type { AgentSessionAdmissionModels } from '../../agent-session-record-options'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionLaunchArgs,
  AgentSessionLaunchEnv,
  AgentSessionRecord
} from '../../../../shared/agent-session-record'
import type {
  StructuredAgentId,
  AgentSessionProviderHandleLink
} from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionAccountHome } from '../../../../shared/agent-session-account-home'

export type AgentSessionReserveRequest = Pick<
  AgentSessionRecord,
  'launchOrigin' | 'launchAuthority' | 'filesystemScope'
> & {
  /** Host-resolved floating directory committed with the first owner reservation. */
  launchDirectory?: string
  sessionId: string
  location: AgentSessionExecutionLocation
  provider: StructuredAgentId
  accountHome: AgentSessionAccountHome
  /** Arguments pinned on first reservation so owner replacement repeats the same launch. */
  launchArgs?: AgentSessionLaunchArgs
  /** Current launch input validated here but never written to the durable record. */
  launchEnv?: AgentSessionLaunchEnv
  /** Initial provider options persisted before the first process is acquired. */
  options?: Readonly<Record<string, string>>
  /** Saved catalog rows those options are admitted against; transient, never written. */
  models?: AgentSessionAdmissionModels
  /** Reserved tab ids are checked before spawn and claimed only when the tab publishes. */
  surfaceTabId?: string
  /** Seed an adopted handle to resume its conversation; absent means a fresh provider conversation. */
  adoptedHandleLink?: AgentSessionProviderHandleLink
  /** Null when the session does not exist yet; otherwise the fence the caller last observed. */
  expectedFence: number | null
  /** A supplier is invoked only when this operation wins a new reservation. */
  spawnToken: string | (() => string)
  claimKeyId: string
  handoffOperationId: string | null
  probe: AgentSessionOwnerProbe
  operation: { callerKey: string; operationId: string; fingerprint: string }
  now: number
  leaseTtlMs?: number
}
