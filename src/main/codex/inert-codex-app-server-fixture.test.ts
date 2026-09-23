import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexCommand } from '../codex-cli/command'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'

// Proves the e2e inert Codex fixture speaks the protocol Orca's REAL connection, handshake,
// thread-open and turn-start code expects, and that its ledger counts what the spec reads.

const FIXTURE_DIR = resolve(__dirname, '../../../tests/e2e/fixtures/inert-codex-app-server')

type LedgerEntry = {
  event?: string
  clientUserMessageId?: string
  inputTexts?: string[]
}

function readLedger(path: string): LedgerEntry[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): LedgerEntry => JSON.parse(line))
}

describe.runIf(process.platform !== 'win32')('inert codex app-server fixture', () => {
  let workDir: string
  let ledger: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'inert-codex-'))
    ledger = join(workDir, 'ledger.jsonl')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('opens a structured session through the real adapter and records one spawn and one turn', async () => {
    // Same shape as the e2e host: the fixture directory prefixed onto PATH, `node` still reachable.
    const pathEnv = [FIXTURE_DIR, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
    const command = resolveCodexCommand({ pathEnv })
    expect(command).toBe(join(FIXTURE_DIR, 'codex'))

    const events: CodexStructuredSessionEvent[] = []
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command,
        args: ['app-server'],
        cwd: workDir,
        codexHome: null,
        resumeThreadId: null,
        env: { PATH: pathEnv, ORCA_E2E_INERT_AGENT_LEDGER: ledger }
      }),
      onEvent: (event) => events.push(event),
      requestTimeoutMs: 10_000
    })
    try {
      const acquisition = await adapter.acquire({
        identity: {
          sessionId: 'session-inert',
          workspaceId: 'ws-inert',
          hostId: 'host-inert',
          agent: 'codex',
          providerHandle: {
            kind: 'opaque',
            agent: 'codex',
            value: 'unopened'
          }
        },
        fence: 1,
        spawnToken: 'spawn-inert'
      })
      expect(acquisition.link.handle).toMatchObject({ provider: 'codex' })

      const outcome = await adapter.dispatch({
        sessionId: 'session-inert',
        clientMessageId: 'client-message-1',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'ship it' }]
        },
        fence: 1
      })
      expect(outcome).toEqual({ state: 'admitted' })

      await vi.waitFor(() =>
        expect(
          events.some((event) => event.type === 'notification' && event.method === 'turn/completed')
        ).toBe(true)
      )
      const methods = events.flatMap((event) =>
        event.type === 'notification' ? [event.method] : []
      )
      expect(methods).toEqual([
        'turn/started',
        'item/completed',
        'item/started',
        'item/agentMessage/delta',
        'item/completed',
        'turn/completed'
      ])
      const echo = events.find(
        (event) => event.type === 'notification' && event.method === 'item/completed'
      )
      expect(echo).toMatchObject({
        params: {
          item: { type: 'userMessage', clientId: 'client-message-1' }
        }
      })
    } finally {
      await adapter.closeAll()
    }

    const entries = readLedger(ledger)
    expect(entries.filter((entry) => entry.event === 'spawn')).toHaveLength(1)
    const turnStarts = entries.filter((entry) => entry.event === 'turn-start')
    expect(turnStarts).toHaveLength(1)
    expect(turnStarts[0]).toMatchObject({
      clientUserMessageId: 'client-message-1',
      inputTexts: ['ship it']
    })
  }, 30_000)
})
