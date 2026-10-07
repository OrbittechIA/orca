import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { callPairedRuntime } from './helpers/paired-client-host-session'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY
} from '../../src/shared/protocol-version'
import { structuredAgentSessionCreateParams } from '../../src/shared/structured-agent-session-create'
import { structuredAgentSessionPayloadFingerprint } from '../../src/shared/structured-agent-session-mutation'
import { parseBuildProvenance } from '../../src/shared/build-provenance'
import { collectWorkItemStartE2eEvidence } from './work-item-start-e2e-collect'
import {
  persistWorkItemStartE2eEvidence,
  workItemStartE2eDefects
} from './work-item-start-e2e-evidence'
import type { CandidateManifest } from './work-item-start-candidate-manifest'

// Why this topology and no other: the Work Item Start that failed was never the desktop's. It came
// from a PAIRED client — `creatorProvenance: { kind: 'paired-device' }` — whose Start ended at
// `worktree.create` with the issue URL as `startupDraft`. The host turns that into a raw TUI
// terminal, which carries no session identity, so `worktree ps` reports `agents: []` and every
// reconciler fails closed on it. Proving the fix on a local client would prove the wrong path.
//
// This spec is POSITIVE. A paired Electron client declares the Start-scoped client capability
// (never the generic structured one), and that is the admission this Start must now receive.
//
// WHAT THIS SPEC PROVES, AND WHAT IT DOES NOT. Steps 1-5 exercise the CONTRACT over RPC:
// negotiation, scoped admission, creation, one delivery and the official projection; they run in
// PR CI against the inert Codex fixture. Step 6, the candidate evidence, runs only in the
// certification lane (`ORCA_WORK_ITEM_START_CERTIFICATION=1`) against a packaged candidate, where a
// missing fixture or manifest is a hard failure. Neither replaces the final gate: clicking Start on
// the Windows Desktop and letting the client pick the route itself.

// Deliberately synthetic: a real work item number here would make lab evidence indistinguishable
// from the production run this work exists to unblock.
const SYNTHETIC_WORK_ITEM = 424242

/**
 * `agentSession.create` and `agentSession.send` make the host start the real provider.
 *
 * Without an inert app-server in place of the PATH's Codex, this spec would spawn a real agent on
 * every run. So it runs only when `ORCA_E2E_INERT_AGENT_SERVER` names the DIRECTORY of that
 * fixture (`tests/e2e/fixtures/inert-codex-app-server`, prefixed to the host PATH) and
 * `ORCA_E2E_INERT_AGENT_LEDGER` the file where it records what it received.
 */
const INERT_AGENT_SERVER_DIR = process.env.ORCA_E2E_INERT_AGENT_SERVER
const INERT_AGENT_LEDGER = process.env.ORCA_E2E_INERT_AGENT_LEDGER

/**
 * O fixture precisa estar REALMENTE no lugar antes de o spec rodar.
 *
 * Um diretório sem o executável não desliga nada: o PATH cairia no Codex de verdade do
 * runner e o spec lançaria um agente achando que estava inerte. E um ledger herdado de uma
 * execução anterior faria as contagens começarem acima de zero — dois writers e um deles
 * invisível é exatamente o que este spec existe para detectar.
 */
/** A retry gets its own ledger: the first attempt's lines would otherwise read as extra writers. */
function ledgerForAttempt(retry: number): string {
  return retry === 0 ? (INERT_AGENT_LEDGER ?? '') : `${INERT_AGENT_LEDGER ?? ''}.retry-${retry}`
}

function inertFixtureRefusal(ledger: string): string | null {
  if (!INERT_AGENT_SERVER_DIR || !isAbsolute(INERT_AGENT_SERVER_DIR)) {
    return 'ORCA_E2E_INERT_AGENT_SERVER must be an absolute directory'
  }
  if (!INERT_AGENT_LEDGER || !isAbsolute(INERT_AGENT_LEDGER)) {
    return 'ORCA_E2E_INERT_AGENT_LEDGER must be an absolute path'
  }
  const executable = ['codex', 'codex.cmd', 'codex.exe'].find((name) =>
    existsSync(join(INERT_AGENT_SERVER_DIR, name))
  )
  if (!executable) {
    return `no codex fixture in ${INERT_AGENT_SERVER_DIR}: the host would resolve the real provider from PATH`
  }
  if (existsSync(ledger) && statSync(ledger).size > 0) {
    return `${ledger} is not empty: a stale ledger makes every count start above zero`
  }
  return null
}

/** The dedicated lane that certifies a packaged candidate. Nothing may skip there. */
const CERTIFICATION = process.env.ORCA_WORK_ITEM_START_CERTIFICATION === '1'

/**
 * O ledger do fixture é a fonte do desfecho.
 *
 * `agentSession.history` diz o que o journal aceitou; só o provider sabe quantas vezes foi
 * de fato despachado. Um segundo writer que o journal não registre apareceria aqui e em
 * lugar nenhum mais — que é exatamente o dano sob prova.
 */
function readInertLedger(ledger: string): { turnStarts: number; spawns: number } {
  const raw = readFileSync(ledger, 'utf8')
  const entries: { event?: string; spawnToken?: string | null }[] = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
  return {
    turnStarts: entries.filter((entry) => entry.event === 'turn-start').length,
    // Only structured-session spawns carry a spawn token; another host feature probing `codex`
    // is not a second executor of this Start.
    spawns: entries.filter((entry) => entry.event === 'spawn' && Boolean(entry.spawnToken)).length
  }
}

type StatusResult = {
  capabilities?: string[]
  deviceScope?: string
  appVersion?: string
  runtimeId?: string
}
type CreatedWorktree = { worktree: { id: string } }
type SupportResult = { supported?: boolean; reason?: string }
type MutationResult<T> = { ok: boolean; value?: T; refusal?: { code: string } }
type AttachResult = { sessionId: string; fence: number }
type SendResult = { submission: { dispatchState: string } }
type PsResult = {
  worktrees: {
    worktreeId: string
    liveTerminalCount: number
    agents: { agentType: string | null; sessionId?: string }[]
  }[]
}
type TerminalsResult = { terminals: { handle: string }[] }
type AttestationResult = {
  sha256?: string
  bytes?: number
  platform?: string
  arch?: string
  buildProvenance?: unknown
  appContent?: { kind: string; sha256?: string } | null
  attestationId?: string
} | null
type HistoryResult = { page?: { items?: { role?: string; kind?: string }[] } }

test('a paired Work Item Start opens one structured session and delivers its prompt once', async ({
  testRepoPath
}, testInfo) => {
  const ledger = ledgerForAttempt(testInfo.retry)
  const fixtureRefusal = inertFixtureRefusal(ledger)
  if (CERTIFICATION && fixtureRefusal !== null) {
    throw new Error(`certification requires the inert agent fixture: ${fixtureRefusal}`)
  }
  test.skip(fixtureRefusal !== null, fixtureRefusal ?? '')
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost({
    // The fixture must win over the runner's Codex; a prefix, not a replacement, because the host
    // still needs git and the shell it launches agents through.
    pathPrefixDir: INERT_AGENT_SERVER_DIR ?? '',
    extraEnv: { ORCA_E2E_INERT_AGENT_LEDGER: ledger }
  })
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  try {
    client = await launchPairedElectronClient(host.offer, testInfo, 'work-item-start')
    const selector = client.environmentId
    const call = async <T>(method: string, params: unknown): Promise<T> =>
      callPairedRuntime<T>(client!.page, selector, method, params)

    // 1. Negotiation. Both halves are host facts the client must read before it is allowed to
    //    drop the terminal startup: the capability says this build has the scoped route, the
    //    device scope says this pairing may use it.
    const status = await call<StatusResult>('status.get', {})
    expect(status.capabilities).toContain(WORK_ITEM_START_STRUCTURED_SESSION_RUNTIME_CAPABILITY)
    expect(status.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(status.deviceScope).toBe('runtime')

    await call('settings.update', { workItemStartPromptDelivery: 'submit-after-ready' })
    const settings = await call<{ settings: { workItemStartPromptDelivery?: string } }>(
      'settings.get',
      null
    )
    expect(settings.settings.workItemStartPromptDelivery).toBe('submit-after-ready')

    const added = await call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const repoId = added.repo.id

    // 2. The Start itself, exactly as the fixed client issues it: no `startupDraft`, because the
    //    session owns the first surface and a seeded pane would be a second, unidentifiable writer.
    const created = await call<CreatedWorktree>('worktree.create', {
      repo: `id:${repoId}`,
      name: 'work-item-start-structured',
      setupDecision: 'skip',
      activate: true,
      linkedIssue: SYNTHETIC_WORK_ITEM,
      createdWithAgent: 'codex'
    })
    const worktreeId = created.worktree.id

    // 3. Admission. The scoped route is what this client asks for, and a client that declares the
    //    structured capability is one the host can hand a session to.
    const sessionId = `codex_${testInfo.testId.replace(/[^A-Za-z0-9]/g, '_')}`
    const support = await call<SupportResult>('agentSession.createSupport', {
      worktree: `id:${worktreeId}`,
      agent: 'codex',
      launchOrigin: 'work-item-start',
      sessionId
    })
    expect(support.supported).toBe(true)

    const createParams = structuredAgentSessionCreateParams({
      sessionId,
      worktree: `id:${worktreeId}`,
      agent: 'codex',
      launchOrigin: 'work-item-start',
      randomUuid: () => randomUUID()
    })
    const createdSession = await call<MutationResult<AttachResult>>(
      'agentSession.create',
      createParams
    )
    expect(createdSession.ok).toBe(true)
    expect(createdSession.value?.sessionId).toBe(sessionId)
    const fence = createdSession.value?.fence ?? 0

    // 4. One delivery. The prompt is the work item's own launch text, sent once through the
    //    session that was just admitted — never seeded into a pane.
    const body = { text: `https://example.invalid/issues/${SYNTHETIC_WORK_ITEM}`, attachments: [] }
    const send = await call<MutationResult<SendResult>>('agentSession.send', {
      envelope: {
        sessionId,
        clientOperationId: randomUUID(),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      },
      body
    })
    expect(send.ok).toBe(true)
    expect(['accepted', 'pending']).toContain(send.value?.submission.dispatchState)

    // 5. The official projection: one executor carrying the session identity, and no terminal.
    //    `agents: []` with a live pane is the incident signature this work removes.
    const ps = await call<PsResult>('worktree.ps', { limit: 50 })
    const summary = ps.worktrees.find((entry) => entry.worktreeId === worktreeId)
    expect(summary?.liveTerminalCount).toBe(0)
    expect(summary?.agents).toHaveLength(1)
    expect(summary?.agents[0]?.sessionId).toBe(sessionId)

    const finalTerminals = await call<TerminalsResult>('terminal.list', {
      worktree: `id:${worktreeId}`
    })
    expect(finalTerminals.terminals).toEqual([])

    // Entrega é PROVADA, não afirmada: o journal da sessão é quem sabe quantas mensagens do
    // cliente chegaram. Um `1` escrito à mão aqui seria a asserção provando a si mesma.
    const history = await call<HistoryResult>('agentSession.history', {
      sessionId,
      direction: 'tail',
      limit: 50
    })
    const journalled = (history.page?.items ?? []).filter(
      (item) => item.role === 'user' || item.kind === 'user-message'
    ).length
    const ledgerCounts = readInertLedger(ledger)
    // As duas pontas precisam concordar: o journal diz o que foi aceito, o provider diz o que
    // foi despachado. Divergência aqui é um writer que uma das duas não viu.
    expect(journalled).toBe(1)
    expect(ledgerCounts.turnStarts).toBe(1)
    expect(ledgerCounts.spawns).toBe(1)
    const promptDeliveries = ledgerCounts.turnStarts

    if (!CERTIFICATION) {
      // PR CI stops at the contract: both sides here are the same unpackaged Electron, which no
      // candidate manifest can bind.
      return
    }

    // 6. Live provenance, captured from the two processes that just did the above. Nothing is
    //    typed: the client reads itself through `app.evaluate`, the host attests its own binary,
    //    and the candidate manifest is what both are matched against.
    // O cliente atesta a SI MESMO pelo seu próprio runtime local, e o servidor pelo pareado.
    // `app.evaluate` não serve para ler a identidade embutida: o `define` do empacotador
    // substitui referências dentro do bundle, e o código que o Playwright serializa nunca
    // passa por ele — leria `undefined` e chamaria isso de ausência.
    const [clientAttestationJson, serverAttestation] = await Promise.all([
      client.page.evaluate(async () => {
        const response = await window.api.runtime.call({
          method: 'runtime.buildAttestation',
          params: null
        })
        return response.ok ? JSON.stringify(response.result) : null
      }),
      call<AttestationResult>('runtime.buildAttestation', null)
    ])
    const clientAttestation: AttestationResult = clientAttestationJson
      ? JSON.parse(clientAttestationJson)
      : null
    const clientProcess = await client.app.evaluate(({ app }) => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: String(require('node:os').release()),
      execPath: process.execPath
    }))
    expect(clientAttestation?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // Required in this lane: without a manifest the evidence binds the processes to no artifact,
    // so the spec fails here instead of passing without proof.
    const manifestModule = await import('./work-item-start-candidate-manifest')
    const manifest: CandidateManifest = manifestModule.readCandidateManifest(
      manifestModule.requireCandidateManifestPath(process.env)
    )
    const expectedCommit = manifestModule.candidateExpectedCommit(process.env)

    {
      const evidence = await collectWorkItemStartE2eEvidence({
        now: () => new Date().toISOString(),
        readClientProcess: async () => ({
          appVersion: clientProcess.appVersion,
          platform: clientProcess.platform,
          arch: clientProcess.arch,
          osRelease: clientProcess.osRelease,
          execPath: clientProcess.execPath,
          buildProvenance: parseBuildProvenance(clientAttestation?.buildProvenance),
          appContentSha256:
            clientAttestation?.appContent?.kind === 'app-asar'
              ? (clientAttestation.appContent.sha256 ?? null)
              : null,
          attestationId: clientAttestation?.attestationId ?? null
        }),
        readServerStatus: async () => ({
          appVersion: status.appVersion,
          ...(status.runtimeId !== undefined ? { runtimeId: status.runtimeId } : {}),
          capabilities: status.capabilities ?? [],
          // Do host, nunca do runner que coleta.
          ...(serverAttestation?.platform !== undefined
            ? { hostPlatform: serverAttestation.platform }
            : {})
        }),
        readServerAttestation: async () =>
          serverAttestation
            ? {
                ...serverAttestation,
                buildProvenance: parseBuildProvenance(serverAttestation.buildProvenance)
              }
            : null,
        manifest,
        ...(expectedCommit !== undefined ? { expectedCommit } : {}),
        artifacts: {
          client: process.env.ORCA_CANDIDATE_CLIENT_ARTIFACT ?? '',
          server: process.env.ORCA_CANDIDATE_SERVER_ARTIFACT ?? ''
        },
        outcome: {
          sessionId,
          promptDeliveries,
          terminalLocator: finalTerminals.terminals[0]?.handle ?? null,
          executors: ledgerCounts.spawns
        }
      })
      const written = persistWorkItemStartE2eEvidence('paired-work-item-start', evidence)
      testInfo.attachments.push({
        name: 'work-item-start-e2e',
        path: written,
        contentType: 'application/json'
      })
      // The collection reads live values rather than constants.
      expect(clientProcess.appVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(clientProcess.execPath.length).toBeGreaterThan(0)
      expect(serverAttestation?.sha256).toMatch(/^[0-9a-f]{64}$/)
      // Two hosts, two builds: one attestation identity for both would betray one-sided collection.
      expect(serverAttestation?.attestationId).not.toBe(clientAttestation?.attestationId)
      // The candidate gate itself: the run proves WHICH binaries proved the behaviour above, and
      // without that binding it is not a pass (see `requireCandidateManifestPath`).
      expect(workItemStartE2eDefects(evidence)).toEqual([])
    }
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
