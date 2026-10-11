import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'
import { PR_CHECK_JOBS } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const unit = parse(readFileSync('.github/workflows/unit-tests.yml', 'utf8'))
const native = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
const e2e = readFileSync('.github/workflows/e2e.yml', 'utf8')
const BASE = '2bb20586ebc39d605e16d95f57420e20a16e7485'
const BASE_TREE = 'f7e0d5d058475cf246f53f3d68086a1ab101d45f'
const CANDIDATE = 'a'.repeat(40)
const CANDIDATE_TREE = 'b'.repeat(40)
const guard = workflow.jobs.code_paths.steps.find(
  (step) => step.name === 'Verify candidate source identity'
)
const classifier = workflow.jobs.code_paths.steps.find((step) => step.id === 'filter')

async function runBashReceipt(script, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-source-candidate-'))
  const receipt = join(directory, 'receipt')
  try {
    const result = await runProcess({
      program: 'bash',
      args: ['-c', script],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        GITHUB_OUTPUT: receipt,
        GITHUB_STEP_SUMMARY: receipt,
        ORCA_SOURCE_BASE: BASE,
        ...env
      },
      timeoutMs: 10_000
    })
    const text = await readFile(receipt, 'utf8').catch(() => '')
    return { ...result, text }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const fakeGit = `
git() {
  case "$1 $2" in
    'rev-parse HEAD') printf '%s\\n' "$FAKE_HEAD" ;;
    'rev-parse HEAD^{tree}') printf '%s\\n' "$FAKE_TREE" ;;
    "rev-parse \${ORCA_SOURCE_BASE}^{tree}") printf '%s\\n' "$FAKE_BASE_TREE" ;;
    'merge-base --is-ancestor') return "$FAKE_ANCESTOR_STATUS" ;;
    *) return 2 ;;
  esac
}
`

function identityEnvironment(overrides = {}) {
  return {
    CANDIDATE_COMMIT: CANDIDATE,
    EVENT_COMMIT: CANDIDATE,
    WORKFLOW_COMMIT: CANDIDATE,
    FAKE_HEAD: CANDIDATE,
    FAKE_TREE: CANDIDATE_TREE,
    FAKE_BASE_TREE: BASE_TREE,
    FAKE_ANCESTOR_STATUS: '0',
    ...overrides
  }
}

describe('source candidate certification wiring', () => {
  it('requires an immutable pin and fixes the official224 base', () => {
    expect(workflow.on.workflow_dispatch.inputs.candidate_commit).toMatchObject({
      required: true,
      type: 'string'
    })
    expect(workflow.env.ORCA_SOURCE_BASE).toContain(BASE)
    expect(workflow.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(guard.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(guard.env).toEqual({
      CANDIDATE_COMMIT: '${{ inputs.candidate_commit }}',
      EVENT_COMMIT: '${{ github.sha }}',
      WORKFLOW_COMMIT: '${{ github.workflow_sha }}'
    })
  })

  it('pins every direct checkout and both reusable unit consumers', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses === 'actions/checkout@v6') {
          expect(step.with.ref).toBe("${{ inputs.candidate_commit || '' }}")
        }
      }
    }
    expect(workflow.jobs.test.with.ref).toBe("${{ inputs.candidate_commit || '' }}")
    for (const name of ['e2e', 'windows_wsl']) {
      expect(workflow.jobs[name].with.ref).toBe(
        '${{ inputs.candidate_commit || github.event.pull_request.head.sha }}'
      )
    }
    expect(unit.on.workflow_call.inputs.ref).toMatchObject({ default: '', required: false })
    for (const job of Object.values(unit.jobs)) {
      const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v6')
      expect(checkout.with.ref).toBe('${{ inputs.ref }}')
    }
  })

  it('runs full five-shard Node24 work regardless of repository selection variables', () => {
    const plan = workflow.jobs.preflight.steps.find((step) => step.id === 'unit-plan')
    const evaluate = (expression, event_name) =>
      runInNewContext(expression.slice(3, -2), {
        github: { event_name },
        vars: { ORCA_UNIT_FULL_SHARD_COUNT: '10', ORCA_UNIT_SELECTION_MODE: 'selected' }
      })
    expect(evaluate(plan.env.ORCA_UNIT_FULL_SHARD_COUNT, 'workflow_dispatch')).toBe('5')
    expect(evaluate(plan.env.ORCA_UNIT_SELECTION_MODE, 'workflow_dispatch')).toBe('shadow')
    expect(evaluate(plan.env.ORCA_UNIT_FULL_SHARD_COUNT, 'pull_request')).toBe('10')
    expect(JSON.parse(workflow.jobs.test.with.node_versions)).toEqual(['24'])
    const shard = unit.jobs.test.steps.find((step) => step.name === 'Test shard')
    expect(shard.run).toContain('pnpm exec vitest run')
    expect(shard.run).not.toContain('run-vitest.mjs')
    expect(shard.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(shard.run).toContain('ORCA_SHARD_SOURCE_SHA="$(git rev-parse HEAD)"')
  })

  it('requires exact-source native qualification and keeps ACP and dedicated SSH lanes', () => {
    expect(workflow.jobs.native_smoke.uses).toBe('./.github/workflows/node-server-tests.yml')
    expect(workflow.jobs.native_smoke.with).toEqual({
      ref: '${{ inputs.candidate_commit }}',
      build_template: false
    })
    expect(workflow.jobs.native_smoke.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(workflow.jobs.native_smoke.if).toContain("needs.preflight.result == 'success'")
    expect(workflow.jobs.verify.needs).toContain('native_smoke')
    expect(native.jobs.persistence.strategy.matrix.os).toContain('ubuntu-22.04')
    expect(native.jobs.persistence.strategy.matrix.os).toContain('windows-2022')
    for (const name of [
      'persistence',
      'linux_glibc_floor',
      'linux_glibc217_compat',
      'linux_musl'
    ]) {
      const checkout = native.jobs[name].steps.find((step) => step.uses === 'actions/checkout@v6')
      expect(checkout.with.ref).toBe('${{ inputs.ref }}')
    }
    expect(
      workflow.jobs.preflight.steps.some((step) => step.run === 'pnpm run verify:acp-protocol')
    ).toBe(true)
    expect(e2e.match(/ssh-emptied-worktree-reactivation\.spec\.ts/g)).toHaveLength(2)
  })
})

describe.skipIf(process.platform === 'win32')('candidate guards through their actual Bash', () => {
  it('records the exact candidate identity after verifying its source and base', async () => {
    const result = await runBashReceipt(fakeGit + guard.run, identityEnvironment())
    expect(result.code).toBe(0)
    expect(result.text).toContain(`Source ${CANDIDATE}; tree ${CANDIDATE_TREE}; base ${BASE}`)
  })

  it.each([
    { CANDIDATE_COMMIT: 'main' },
    { CANDIDATE_COMMIT: CANDIDATE.slice(0, 12) },
    { FAKE_HEAD: 'c'.repeat(40) },
    { EVENT_COMMIT: 'c'.repeat(40) },
    { WORKFLOW_COMMIT: 'c'.repeat(40) },
    { FAKE_BASE_TREE: 'c'.repeat(40) },
    { FAKE_ANCESTOR_STATUS: '1' }
  ])('refuses mismatched or ambiguous certification input: %j', async (overrides) => {
    const result = await runBashReceipt(fakeGit + guard.run, identityEnvironment(overrides))
    expect(result.code).toBe(1)
    expect(result.text).toBe('')
  })

  it.each(['workflow_dispatch', 'pull_request'])(
    'classifies a docs-only %s with the actual workflow',
    async (event) => {
      const shim = `
node() {
  if [ "$1" = config/scripts/git-pull-request-diff-base.mjs ]; then
    printf '%s\\n' "$BASE_SHA"
  else
    command node "$@"
  fi
}
git() { printf '%s\\n' README.md; }
`
      const result = await runBashReceipt(shim + classifier.run, {
        GITHUB_EVENT_NAME: event,
        BASE_SHA: BASE
      })
      expect(result.code).toBe(0)
      const outputs = Object.fromEntries(
        result.text
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      )
      for (const name of ['should_run', ...PR_CHECK_JOBS]) {
        expect(outputs[name], name).toBe(String(event === 'workflow_dispatch'))
      }
    }
  )

  it.each(['success', '', 'skipped', 'failure', 'cancelled'])(
    'requires completed native smoke: %s',
    async (status) => {
      const nativeGate = workflow.jobs.verify.steps.find(
        (step) => step.name === 'Require candidate native smoke'
      )
      expect(nativeGate.if).toBe("github.event_name == 'workflow_dispatch'")
      const result = await runBashReceipt(nativeGate.run, { NATIVE_SMOKE: status })
      expect(result.code).toBe(status === 'success' ? 0 : 1)
    }
  )
})

it('requires the complete candidate native smoke result', () => {
  const nativeGate = workflow.jobs.verify.steps.find(
    (step) => step.name === 'Require candidate native smoke'
  )
  expect(nativeGate.if).toBe("github.event_name == 'workflow_dispatch'")
  expect(nativeGate.env.NATIVE_SMOKE).toBe('${{ needs.native_smoke.result }}')
  expect(nativeGate.run).toBe('test "$NATIVE_SMOKE" = success')
})
