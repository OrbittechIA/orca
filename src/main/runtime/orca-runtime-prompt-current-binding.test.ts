import { describe, expect, it } from 'vitest'
import { OrcaRuntimeWithAgentPromptRequestCorrelation } from './orca-runtime-agent-prompt-request-correlation'

function bindingFixture() {
  const pty: {
    ptyId: string
    connected: boolean
    paneKey: string
    incarnationId: string
    launchIncarnationId: string
    launchToken: string
    connectionId: string | null
    wslDistro: string | null
  } = {
    ptyId: 'pty_1',
    connected: true,
    paneKey: 'tab:pane',
    incarnationId: 'inc_1',
    launchIncarnationId: 'inc_1',
    launchToken: 'launch-secret',
    connectionId: null,
    wslDistro: null
  }
  const row: {
    paneKey: string
    connectionId: string | null
    launchToken: string
    agentType: string
    receivedAt: number
    providerSession: { key: string; id: string }
  } = {
    paneKey: 'tab:pane',
    connectionId: null,
    launchToken: 'launch-secret',
    agentType: 'codex',
    receivedAt: 200,
    providerSession: { key: 'session_id', id: 'provider_1' }
  }
  const host = {
    getLivePtyForHandle: () => ({ pty }),
    getTerminalPromptRequestBinding: () => ({
      ptyId: 'pty_1',
      processIncarnation: 'inc_1',
      generation: 0
    }),
    wslDistroByPtyId: new Map<string, string>(),
    getAgentStatusSnapshotFn: () => [row]
  }
  const read = (): unknown =>
    Reflect.apply(
      OrcaRuntimeWithAgentPromptRequestCorrelation.prototype.getTerminalPromptCurrentBinding,
      host,
      ['term_1', 150]
    )
  return { pty, row, read }
}

describe('current prompt binding runtime projection', () => {
  it('publishes the exact current session and a commitment instead of its launch secret', () => {
    const { read } = bindingFixture()
    const result = read()
    expect(result).toMatchObject({
      terminal: 'term_1',
      ptyId: 'pty_1',
      processIncarnation: 'inc_1',
      generation: 0,
      paneKey: 'tab:pane',
      connectionId: null,
      provider: 'codex',
      providerSession: { id: 'provider_1' },
      observedAt: 200,
      launchTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(result)).not.toContain('launch-secret')
  })

  it('refuses a disconnected or reused incarnation even with a matching hook row', () => {
    const { pty, read } = bindingFixture()
    pty.connected = false
    expect(read()).toBeNull()
    pty.connected = true
    pty.launchIncarnationId = 'old_incarnation'
    expect(read()).toBeNull()
    pty.launchIncarnationId = pty.incarnationId
    pty.launchToken = ''
    expect(read()).toBeNull()
  })

  it('keeps SSH connection authority on its owning host', () => {
    const { pty, row, read } = bindingFixture()
    pty.connectionId = 'ssh_host_1'
    expect(read()).toBeNull()
    row.connectionId = 'ssh_host_1'
    expect(read()).toMatchObject({ connectionId: 'ssh_host_1' })
    row.connectionId = 'ssh_host_2'
    expect(read()).toBeNull()
  })

  it('requires the attested WSL distro for a local PTY', () => {
    const { pty, row, read } = bindingFixture()
    pty.wslDistro = 'Ubuntu'
    row.connectionId = 'wsl:Debian'
    expect(read()).toBeNull()
    row.connectionId = 'wsl:Ubuntu'
    expect(read()).toMatchObject({ connectionId: 'wsl:Ubuntu' })
  })
})
