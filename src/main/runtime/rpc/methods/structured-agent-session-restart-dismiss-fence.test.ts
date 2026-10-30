import '../unused-default-rpc-methods.test-fixture'
// Drive desktop's real dispatch context: dismissal fences only chats it removed; older clients must preserve offers they cannot render.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  AgentSessionRecoveryCapsule
} from '../../agent-session-recovery-capsule'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { CLAUDE_STRUCTURED_AGENT } from '../../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/structured-agent-registry'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { interruptedRestart } from '../../../native-chat/agent-session-wire/structured-agent-session-restart-interruption-test-harness'
import { HOST_TEST_NOW as NOW } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { call, clearStructuredHostStub } from './structured-agent-session-rpc.test-fixture'

afterEach(() => {
  clearStructuredHostStub()
  vi.restoreAllMocks()
})

// Exactly what `runtime:call` in src/main/ipc/runtime.ts dispatches the local renderer with.
const DESKTOP = {
  clientKind: 'runtime' as const,
  clientCapabilities: [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]
}
const OLDER_DESKTOP = {
  ...DESKTOP,
  clientCapabilities: DESKTOP.clientCapabilities.filter(
    (capability) => capability !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a registry reads only the methods a declaration needs; these declare none.
const NO_METHODS = {} as StructuredAgentSessionAdapter
const declaring = (definition: typeof CLAUDE_STRUCTURED_AGENT) => ({
  definition: {
    ...definition,
    capabilities: { ...definition.capabilities, compact: false, threadGoal: false, rewind: false }
  },
  adapter: NO_METHODS
})

/** Claude and Codex plus one agent an older desktop does not render. */
function withPilot(): StructuredAgentRegistry {
  return new StructuredAgentRegistry([
    declaring(CLAUDE_STRUCTURED_AGENT),
    declaring(CODEX_STRUCTURED_AGENT),
    declaring({ ...CODEX_STRUCTURED_AGENT, agent: 'grok', accountHomeVariable: 'GROK_HOME' })
  ])
}

async function storedFence(root: string) {
  const { dismissedAt, sessionFences } = JSON.parse(
    await readFile(join(root, AGENT_SESSION_RECOVERY_CAPSULE_FILE), 'utf8')
  )
  return { ...(dismissedAt ? { dismissedAt } : {}), ...(sessionFences ? { sessionFences } : {}) }
}

async function dismissAllFromDesktop(client = DESKTOP) {
  return call('agentSession.restartResumableDismiss', {}, client)
}

it('fences a dismissed offer against a late teardown write when the desktop sees every agent', async () => {
  const { host, root, marker } = await interruptedRestart()
  setStructuredAgentSessionHost(host)
  const capsule = new AgentSessionRecoveryCapsule(root)
  // An offer whose chat has no record this caller can prove it may act on.
  const unrecorded = { ...marker!, sessionId: 'unrecorded-session' }
  await capsule.record([unrecorded], NOW)

  expect(await dismissAllFromDesktop()).toMatchObject({ ok: true, result: { dismissed: 1 } })
  // A teardown writer that captured this chat before the dismissal publishes late.
  await capsule.record([marker!], NOW)

  expect(await capsule.list(NOW)).toEqual([unrecorded])
  // The fence names the dismissed chat only: a chat nobody dismissed, perhaps another caller's, still lands.
  expect(await storedFence(root)).toEqual({
    sessionFences: [{ sessionId: marker!.sessionId, dismissedAt: NOW + 1 }]
  })
  const unseen = { ...marker!, sessionId: 'unseen-session' }
  await capsule.record([unseen], NOW)
  expect(await capsule.list(NOW)).toEqual([unrecorded, unseen])
  expect(await call('agentSession.restartResumable', {}, DESKTOP)).toMatchObject({
    ok: true,
    result: { sessions: [] }
  })
})

it('leaves offers it was not shown when the host runs an agent an older desktop cannot show', async () => {
  const { host, root, marker } = await interruptedRestart(undefined, undefined, withPilot())
  setStructuredAgentSessionHost(host)
  const capsule = new AgentSessionRecoveryCapsule(root)
  // An offer whose chat this launch cannot read names no agent the desktop was shown.
  const unreadable = { ...marker!, sessionId: 'unreadable-session' }
  await capsule.record([unreadable], NOW)

  expect(await dismissAllFromDesktop(OLDER_DESKTOP)).toMatchObject({
    ok: true,
    result: { dismissed: 1 }
  })

  expect(await capsule.list(NOW)).toEqual([unreadable])
  // A scoped dismissal fences only what it cleared: nothing it did not clear may be dropped later.
  await capsule.record([marker!], NOW)
  expect(await capsule.list(NOW)).toEqual([unreadable])
  expect(await storedFence(root)).toEqual({
    sessionFences: [{ sessionId: marker!.sessionId, dismissedAt: NOW + 1 }]
  })
})
