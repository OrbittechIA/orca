// The paired Work Item Start contract spec must RUN in PR CI (not skip), while candidate
// certification stays out of PR CI entirely.

import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const FIXTURE_DIR = 'tests/e2e/fixtures/inert-codex-app-server'
const e2eWorkflow = () => parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

function stepRuns(job) {
  return (job?.steps ?? []).map((step) => String(step.run ?? ''))
}

describe('paired Work Item Start e2e wiring', () => {
  it.each([
    ['sharded suite', (jobs) => stepRuns(jobs.e2e).find((run) => run.includes('test:e2e'))],
    [
      'changed specs',
      (jobs) =>
        Object.values(jobs)
          .flatMap(stepRuns)
          .find((run) => run.includes('E2E_ENV=('))
    ]
  ])('sets the inert agent fixture and ledger in the %s lane', (_lane, pick) => {
    const run = pick(e2eWorkflow().jobs)
    expect(run).toBeDefined()
    expect(run).toContain(`ORCA_E2E_INERT_AGENT_SERVER="$GITHUB_WORKSPACE/${FIXTURE_DIR}"`)
    expect(run).toMatch(/ORCA_E2E_INERT_AGENT_LEDGER="\$RUNNER_TEMP\/[^"]+\.jsonl"/)
  })

  it('ships an executable POSIX fixture and a Windows launcher', () => {
    expect(() => accessSync(join(projectDir, FIXTURE_DIR, 'codex'), constants.X_OK)).not.toThrow()
    expect(readFileSync(join(projectDir, FIXTURE_DIR, 'codex.cmd'), 'utf8')).toContain(
      'inert-codex-app-server.cjs'
    )
  })

  it('never turns on candidate certification in any workflow', () => {
    const workflows = readdirSync(join(projectDir, '.github/workflows')).filter((name) =>
      /\.ya?ml$/.test(name)
    )
    for (const name of workflows) {
      const text = readFileSync(join(projectDir, '.github/workflows', name), 'utf8')
      expect(text, name).not.toMatch(/ORCA_WORK_ITEM_START_CERTIFICATION/)
    }
  })
})
