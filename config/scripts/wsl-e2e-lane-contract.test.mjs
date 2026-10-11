import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hasWslSourceChange, selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('real WSL terminal lane', () => {
  it.each([
    'config/scripts/verify-wsl-e2e-participation.mjs',
    'config/scripts/verify-playwright-participation.mjs',
    'src/main/wsl-availability.ts',
    'src/main/wsl/wsl-runner.ts',
    'src/main/pty/wsl-orca-env.ts',
    'src/shared/wsl-login-shell-command.ts',
    'src/shared/windows-terminal-shell.ts',
    'tests/e2e/helpers/wsl-golden-stub-agent.ts',
    'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
    'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts',
    '.github/actions/setup-wsl-test-runtime/setup.ps1',
    '.github/workflows/windows-wsl-e2e.yml'
  ])('routes %s to both WSL sentinels', (path) => {
    expect(hasWslSourceChange([path])).toBe(true)
    expect(selectPrE2eSpecs([path])).toEqual(
      expect.arrayContaining([
        'tests/e2e/golden-tab-bar-agent-launch.spec.ts',
        'tests/e2e/terminal-windows-shell-paste-ownership.spec.ts'
      ])
    )
  })

  it.each([
    'docs/reference/wsl-command-execution.md',
    'src/main/wsl-availability.test.ts',
    'src/main/ssh/connection.ts'
  ])('excludes unrelated or unit-only change %s', (path) => {
    expect(hasWslSourceChange([path])).toBe(false)
  })

  it('runs the reusable lane at the immutable candidate or PR head', () => {
    const pr = parse(read('.github/workflows/pr.yml'))
    expect(pr.jobs.windows_wsl.if).toBe("needs.code_paths.outputs.wsl_source_changed == 'true'")
    expect(pr.jobs.windows_wsl.with.ref).toBe(
      '${{ inputs.candidate_commit || github.event.pull_request.head.sha }}'
    )
    const detector = pr.jobs['code_paths'].steps.find(
      (step) => step.name === 'Filter changed E2E specs'
    )
    expect(detector.run).toContain(
      'WSL_CHANGED="$(git diff --name-only --no-renames --diff-filter=ACDMR'
    )
    expect(detector.run).toContain(
      '"$WSL_CHANGED" | node config/scripts/pr-e2e-source-routing.mjs --wsl-source'
    )
    const workflow = parse(read('.github/workflows/windows-wsl-e2e.yml'))
    const steps = workflow.jobs['wsl-terminal'].steps
    expect(steps[0].with.ref).toBe('${{ inputs.ref || github.sha }}')
    expect(steps.some((step) => step.uses === './.github/actions/setup-wsl-test-runtime')).toBe(
      true
    )
    const exercise = steps.find((step) => step.name === 'Exercise real WSL launch and paste')
    expect(exercise.run.split(/\s+/).filter((arg) => arg.startsWith('--repeat-each='))).toEqual([
      '--repeat-each=3'
    ])
    expect(exercise.run).toContain('--grep "WSL"')
    const receipt = steps.find((step) => step.name === 'Require all nine WSL executions')
    expect(receipt.if).toBe('always()')
    expect(receipt.run).toBe(
      'node config/scripts/verify-wsl-e2e-participation.mjs test-results/wsl-results.json'
    )
  })

  it('fences dispatch source, event and workflow to a full candidate SHA on official224', () => {
    const pr = parse(read('.github/workflows/pr.yml'))
    expect(pr.on.pull_request.types).toContain('synchronize')
    expect(pr.on.workflow_dispatch.inputs.candidate_commit.required).toBe(true)
    expect(pr.on.workflow_dispatch.inputs.candidate_commit.type).toBe('string')
    expect(pr.env.ORCA_SOURCE_BASE).toBe(
      "${{ github.event_name == 'workflow_dispatch' && '2bb20586ebc39d605e16d95f57420e20a16e7485' || github.event.pull_request.base.sha }}"
    )
    const steps = pr.jobs.code_paths.steps
    expect(steps[0].with.ref).toBe("${{ inputs.candidate_commit || '' }}")
    const guard = steps.find((step) => step.name === 'Verify candidate source identity')
    expect(guard.if).toBe("github.event_name == 'workflow_dispatch'")
    expect(guard.env).toEqual({
      CANDIDATE_COMMIT: '${{ inputs.candidate_commit }}',
      EVENT_COMMIT: '${{ github.sha }}',
      WORKFLOW_COMMIT: '${{ github.workflow_sha }}'
    })
    for (const fence of [
      'set -euo pipefail',
      'if ! [[ "$CANDIDATE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then',
      'SOURCE_COMMIT="$(git rev-parse HEAD)"',
      'test "$SOURCE_COMMIT" = "$CANDIDATE_COMMIT" ||',
      'test "$EVENT_COMMIT" = "$CANDIDATE_COMMIT" ||',
      'test "$WORKFLOW_COMMIT" = "$CANDIDATE_COMMIT" ||',
      'test "$(git rev-parse "${ORCA_SOURCE_BASE}^{tree}")" = f7e0d5d058475cf246f53f3d68086a1ab101d45f ||',
      'git merge-base --is-ancestor "$ORCA_SOURCE_BASE" HEAD ||'
    ]) {
      expect(guard.run).toContain(fence)
    }
    expect(guard.run).toContain('exit 1')
  })
})
