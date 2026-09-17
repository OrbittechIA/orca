import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { structuredAgentSessionCreateWorktreeTarget } from '../../structured-agent-session-create-worktree-target'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree
} from './structured-agent-session-create'

// The TOCTOU the review named: A passes the full target check, launch preparation pauses, A is
// deleted and replaced by B at the same id and path, preparation resumes, and the provider
// child attaches in B under A's authority. Closed by the workspace lifecycle hold (removal takes
// the exclusive side) plus a full-target re-check under that hold right before attach.

/** The record fields the authority compares, plus the repo the resolver routes by. */
type WorktreeRecord = Pick<
  Worktree,
  'id' | 'path' | 'instanceId' | 'identity' | 'hostId' | 'creatorProvenance'
> & { repoId: string }

const A: WorktreeRecord = {
  id: 'workspace-1',
  repoId: 'repo-1',
  path: '/repos/workspace-1',
  instanceId: 'instance-a',
  identity: { key: 'identity-a', executionHostId: 'local', instanceId: 'instance-a' },
  creatorProvenance: { kind: 'paired-device', deviceId: 'device-owner' }
}
/** Same selector, same path: a re-created checkout with its own instance, identity and creator. */
const B: WorktreeRecord = {
  ...A,
  instanceId: 'instance-b',
  identity: { key: 'identity-b', executionHostId: 'local', instanceId: 'instance-b' },
  creatorProvenance: { kind: 'paired-device', deviceId: 'device-other' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

function harness() {
  const current = { value: A }
  const launchPreparation = deferred<string>()
  const prepareCodexStructuredLaunch = vi.fn(() => launchPreparation.promise)
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads getRepo/getSettings off the store; the fixture pins those.
    {
      getRepo: () => undefined,
      getSettings: () => ({
        agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
        nativeChatSessionOptions: {
          codex: { model: 'gpt-live', valuesByModel: { 'gpt-live': { effort: 'medium' } } }
        }
      })
    } as never,
    undefined,
    { prepareCodexStructuredLaunch }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite replaces two protected members with fixtures: the file-target resolver and the tab publisher.
  const internal = runtime as unknown as {
    resolveRuntimeFileTarget: (selector: string) => Promise<unknown>
    publishStructuredAgentSessionTab: (args: unknown) => Promise<void>
  }
  internal.resolveRuntimeFileTarget = vi.fn(async () => ({
    executionHostId: 'local',
    worktree: current.value
  }))
  internal.publishStructuredAgentSessionTab = vi.fn(async () => undefined)
  const attach = vi.fn(async (_caller: unknown, _params: unknown) => ({
    ok: true as const,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 0 },
    value: { sessionId: 'session-1', fence: 1 }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: commit calls `host.attach` and nothing else on the host in this suite.
  const host = { attach } as never
  const expectedWorktreeTarget = structuredAgentSessionCreateWorktreeTarget(A)
  const caller = { callerKey: 'caller-1' }
  const prepare = () =>
    prepareStructuredAgentSessionCreateForWorktree({
      runtime,
      ensureHost: async () => host,
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'.repeat(64)
      },
      worktree: 'id:workspace-1',
      agent: 'codex',
      caller,
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' },
      expectedWorktreeTarget
    })
  const commit = (prepared: Awaited<ReturnType<typeof prepare>>) =>
    commitStructuredAgentSessionCreate({ runtime, caller, prepared, activate: true })
  return {
    runtime,
    current,
    launchPreparation,
    prepareCodexStructuredLaunch,
    attach,
    prepare,
    commit
  }
}

describe('structured create holds the workspace lifecycle from resolution through attach', () => {
  it('attaches exactly once to the workspace it was admitted for', async () => {
    const h = harness()
    const preparing = h.prepare()
    await settle()
    h.launchPreparation.resolve('/home/codex')
    const prepared = await preparing
    await expect(h.commit(prepared)).resolves.toMatchObject({ ok: true })
    expect(h.attach).toHaveBeenCalledTimes(1)
    expect(h.attach.mock.calls[0]?.[1]).toMatchObject({
      launchOrigin: 'work-item-start',
      launchAuthority: { kind: 'paired-device', deviceId: 'device-owner' },
      location: { workspaceId: 'workspace-1' }
    })
    // Released: a removal can take the workspace right away.
    const release = await h.runtime.holdWorktreeLifecycleExclusively(
      'workspace-1',
      Date.now() + 100
    )
    release()
  })

  it('never attaches when the workspace is replaced during launch preparation', async () => {
    // A mutation that bypasses removal (the only sanctioned path) is still caught: the exact
    // full target is re-resolved under the hold immediately before attach.
    const h = harness()
    const preparing = h.prepare()
    await settle()
    expect(h.prepareCodexStructuredLaunch).toHaveBeenCalledTimes(1)
    h.current.value = B
    h.launchPreparation.resolve('/home/codex')
    const prepared = await preparing
    await expect(h.commit(prepared)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })
    expect(h.attach).not.toHaveBeenCalled()
    const release = await h.runtime.holdWorktreeLifecycleExclusively(
      'workspace-1',
      Date.now() + 100
    )
    release()
  })

  it('makes a removal wait for the in-flight create, which then attaches to the surviving A', async () => {
    const h = harness()
    const preparing = h.prepare()
    await settle()
    let removalAdmitted = false
    const removal = h.runtime
      .holdWorktreeLifecycleExclusively('workspace-1', Date.now() + 5_000)
      .then((release) => {
        removalAdmitted = true
        release()
      })
    await settle()
    expect(removalAdmitted).toBe(false)
    h.launchPreparation.resolve('/home/codex')
    const prepared = await preparing
    expect(removalAdmitted).toBe(false)
    await expect(h.commit(prepared)).resolves.toMatchObject({ ok: true })
    await removal
    expect(removalAdmitted).toBe(true)
    expect(h.attach).toHaveBeenCalledTimes(1)
  })

  it('a create that arrives during a removal sees the replacement and is refused', async () => {
    const h = harness()
    const release = await h.runtime.holdWorktreeLifecycleExclusively('workspace-1')
    const preparing = h.prepare()
    await settle()
    // Held out: the resolver has not even been asked yet.
    expect(h.prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    h.current.value = B
    release()
    await expect(preparing).rejects.toThrow('structured_agent_session_unsupported')
    expect(h.attach).not.toHaveBeenCalled()
    // The failed prepare released its hold.
    const again = await h.runtime.holdWorktreeLifecycleExclusively('workspace-1', Date.now() + 100)
    again()
  })

  it('a removal that outwaits its deadline is refused as busy, never granted later', async () => {
    const h = harness()
    const preparing = h.prepare()
    await settle()
    await expect(
      h.runtime.holdWorktreeLifecycleExclusively('workspace-1', Date.now() + 20)
    ).rejects.toThrow('worktree_lifecycle_busy')
    h.launchPreparation.resolve('/home/codex')
    await expect(h.commit(await preparing)).resolves.toMatchObject({ ok: true })
    expect(h.attach).toHaveBeenCalledTimes(1)
  })
})
