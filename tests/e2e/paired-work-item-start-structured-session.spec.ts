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
// This spec is POSITIVE. It used to assert the refusal, on the premise that an Electron client's
// declared capability set omitted the structured entries — that premise is gone: the desktop
// renderer IS the structured chat client and now declares them, so the admission it was refused
// for is the admission it must now receive.
//
// O QUE ESTE SPEC PROVA, E O QUE NÃO PROVA. Ele exercita o CONTRATO pelas RPCs: negociação,
// admissão escopada, criação, uma entrega e a projeção oficial. Ele não substitui o gate final,
// que é clicar Start no Desktop Windows e deixar o cliente escolher a rota sozinho — chamar
// `create`/`send` à mão pula exatamente o roteador que já esteve errado. Um verde aqui é
// condição necessária do candidato, nunca a certificação dele.

// Deliberately synthetic: a real work item number here would make lab evidence indistinguishable
// from the production run this work exists to unblock.
const SYNTHETIC_WORK_ITEM = 424242

/**
 * `agentSession.create` e `agentSession.send` fazem o host levantar o provider de verdade.
 *
 * Sem um app-server inerte no lugar do Codex do PATH, este spec passaria a spawnar um agente
 * real a cada execução — o que não é um teste, é um lançamento. Por isso ele só roda quando
 * `ORCA_E2E_INERT_AGENT_SERVER` aponta para o DIRETÓRIO desse fixture (prefixado ao PATH do
 * host) e `ORCA_E2E_INERT_AGENT_LEDGER` para o arquivo onde ele registra o que recebeu.
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
function inertFixtureRefusal(): string | null {
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
  if (existsSync(INERT_AGENT_LEDGER) && statSync(INERT_AGENT_LEDGER).size > 0) {
    return `${INERT_AGENT_LEDGER} is not empty: a stale ledger makes every count start above zero`
  }
  return null
}

const INERT_FIXTURE_REFUSAL = inertFixtureRefusal()

/**
 * O ledger do fixture é a fonte do desfecho.
 *
 * `agentSession.history` diz o que o journal aceitou; só o provider sabe quantas vezes foi
 * de fato despachado. Um segundo writer que o journal não registre apareceria aqui e em
 * lugar nenhum mais — que é exatamente o dano sob prova.
 */
function readInertLedger(): { turnStarts: number; spawns: number } {
  const raw = readFileSync(INERT_AGENT_LEDGER ?? '', 'utf8')
  const entries = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event?: string })
  return {
    turnStarts: entries.filter((entry) => entry.event === 'turn-start').length,
    spawns: entries.filter((entry) => entry.event === 'spawn').length
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
} | null
type HistoryResult = { page?: { items?: { role?: string; kind?: string }[] } }

test('a paired Work Item Start opens one structured session and delivers its prompt once', async ({
  testRepoPath
}, testInfo) => {
  test.skip(INERT_FIXTURE_REFUSAL !== null, INERT_FIXTURE_REFUSAL ?? '')
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost({
    // O fixture precisa vencer o Codex do runner; prefixo, não substituição — o host ainda
    // depende do git e do shell por onde lança agentes.
    pathPrefixDir: INERT_AGENT_SERVER_DIR ?? '',
    extraEnv: { ORCA_E2E_INERT_AGENT_LEDGER: INERT_AGENT_LEDGER ?? '' }
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
    const ledger = readInertLedger()
    // As duas pontas precisam concordar: o journal diz o que foi aceito, o provider diz o que
    // foi despachado. Divergência aqui é um writer que uma das duas não viu.
    expect(journalled).toBe(1)
    expect(ledger.turnStarts).toBe(1)
    expect(ledger.spawns).toBe(1)
    const promptDeliveries = ledger.turnStarts

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
      ? (JSON.parse(clientAttestationJson) as AttestationResult)
      : null
    const clientProcess = await client.app.evaluate(({ app }) => ({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: require('node:os').release() as string,
      execPath: process.execPath
    }))
    expect(clientAttestation?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const manifestPath = process.env.ORCA_CANDIDATE_MANIFEST
    const manifest: CandidateManifest | null = manifestPath
      ? (await import('./work-item-start-candidate-manifest')).readCandidateManifest(manifestPath)
      : null

    if (manifest) {
      const evidence = await collectWorkItemStartE2eEvidence({
        now: () => new Date().toISOString(),
        readClientProcess: async () => ({
          appVersion: clientProcess.appVersion,
          platform: clientProcess.platform,
          arch: clientProcess.arch,
          osRelease: clientProcess.osRelease,
          execPath: clientProcess.execPath,
          buildProvenance: parseBuildProvenance(clientAttestation?.buildProvenance)
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
        artifacts: {
          client: process.env.ORCA_CANDIDATE_CLIENT_ARTIFACT ?? '',
          server: process.env.ORCA_CANDIDATE_SERVER_ARTIFACT ?? ''
        },
        outcome: {
          sessionId,
          promptDeliveries,
          terminalLocator: finalTerminals.terminals[0]?.handle ?? null,
          executors: ledger.spawns
        }
      })
      const written = persistWorkItemStartE2eEvidence('paired-work-item-start', evidence)
      testInfo.attachments.push({
        name: 'work-item-start-e2e',
        path: written,
        contentType: 'application/json'
      })
      // The candidate gate itself. It is only meaningful against a packaged pair, which is why the
      // manifest is opt-in: without it this lab still proves the behaviour above, and with it the
      // same run also proves WHICH binaries proved it.
      expect(workItemStartE2eDefects(evidence)).toEqual([])
    } else {
      // No manifest: still assert the collection reads live values rather than constants.
      expect(clientProcess.appVersion).toMatch(/^\d+\.\d+\.\d+/)
      expect(clientProcess.execPath.length).toBeGreaterThan(0)
      expect(serverAttestation?.sha256).toMatch(/^[0-9a-f]{64}$/)
      // Dois hosts, dois binários: um único hash para ambos denunciaria coleta de um lado só.
      expect(serverAttestation?.sha256).not.toBe(clientAttestation?.sha256)
    }
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
