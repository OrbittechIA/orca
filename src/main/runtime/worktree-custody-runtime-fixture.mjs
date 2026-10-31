import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fixtureRoot,
  moduleFromSource,
  boundaryModule,
  BASE,
  completeObservation
} from './worktree-custody-fixture.mjs'

writeFileSync(
  join(fixtureRoot, 'runtime-ports.mjs'),
  `
  let directory;
  export function setUserData(path) { directory = path; }
  export function hasAppEnvironment() { return true; }
  export function getAppEnvironment() { return { getPath: () => directory }; }
  export const WORKTREE_ID_SEPARATOR = '::';
  export function normalizeRuntimePathForComparison(value) { return value; }
  export function defineMethod(method) { return method; }
  export const WorktreeCustodyRequestSchema = {};
  export let providerInstalls = 0;
  export function installNativeWorktreeCustodyProvider() { providerInstalls++; }
`
)
const runtimePorts = await import(pathToFileURL(join(fixtureRoot, 'runtime-ports.mjs')).href)
await moduleFromSource('worktree-id.mjs', '../../shared/worktree/id.ts', {
  '../cross-platform-path': './runtime-ports.mjs',
  '../pty-session-id-format': './runtime-ports.mjs'
})
const { OrchestrationError } = await moduleFromSource(
  'orchestration-error.mjs',
  './orchestration/orchestration-error.ts'
)
await moduleFromSource(
  'worker-terminal-ownership.mjs',
  './orchestration/worker-terminal-ownership.ts'
)
writeFileSync(join(fixtureRoot, 'contract-constants.mjs'), `export const LEGACY_RUN_ID = 'legacy';`)
const { createCoreTablesSql } = await moduleFromSource(
  'core-tables.mjs',
  './orchestration/db/schema/create-core-tables-sql.ts',
  { '../contract-constants': './contract-constants.mjs' }
)
// Status CHECK copied from create-graph-tables-sql.ts; other columns are not read by custody.
const DISPATCH_CONTEXTS_SQL = `CREATE TABLE dispatch_contexts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')));`
const runtimeCustody = await moduleFromSource('runtime.mjs', './worktree-custody-runtime.ts', {
  './orchestration/worker-terminal-ownership': './worker-terminal-ownership.mjs',
  '../../shared/app-environment': './runtime-ports.mjs',
  '../../shared/worktree/id': './worktree-id.mjs',
  '../../shared/worktree/custody': './custody.mjs',
  './worktree-custody-authority': './authority.mjs',
  './worktree-custody-journal': './journal.mjs',
  './orchestration/orchestration-error': './orchestration-error.mjs'
})
const { WORKTREE_CUSTODY_METHOD } = await moduleFromSource(
  'custody-rpc.mjs',
  './rpc/methods/worktree-custody.ts',
  {
    '../core': './runtime-ports.mjs',
    '../../worktree-custody-runtime': './runtime.mjs',
    '../../../../shared/worktree/custody-schema': './runtime-ports.mjs',
    '../../worktree-custody-native-provider-host': './runtime-ports.mjs'
  }
)

function runtimeFixture(options = {}) {
  runtimePorts.setUserData(mkdtempSync(join(fixtureRoot, 'active-profile-')))
  const custody = runtimeCustody.nativeWorktreeCustody('runtime-1')
  const resource = custody.claim(BASE, 'dispatch:fixture')
  custody.installCoverage(BASE.owner, {
    observe: async (bound) => completeObservation(bound),
    acquire: async () => ({ check: () => true, release: () => {} }),
    retire: options.retire ?? (async () => {}),
    reconcile: async (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: false,
      proof: null
    }),
    recoverFence: async (fence) => ({ fence, recovered: false, proof: null })
  })
  return { custody, resource }
}

const { settleWorkerTerminalRelease } = await moduleFromSource(
  'worker-archive.mjs',
  './orchestration/db/worker-terminal/worker-terminal-archive.ts',
  {
    '../../../worktree-custody-runtime': './runtime.mjs',
    '../../orchestration-error': './orchestration-error.mjs'
  }
)

writeFileSync(
  join(fixtureRoot, 'terminal-ports.mjs'),
  `
  export class OrcaRuntimeWithTerminalCreateDeduplication {}
  export function admitPairedCreateColors() {}
  export function resolveTerminalPresentation() { return 'background'; }
  function unused() { throw new Error('the fixture must stop at asynchronous launch preflight'); }
  export { unused as recordTerminalLaunchMetadata, unused as resolveTerminalLaunchResult,
    unused as terminalLaunchPublicFacts, unused as finishCreatedTerminal, unused as createDesktopTerminal,
    unused as terminalCreateTeamAllocation, unused as createIdempotentCallback, unused as recordPtySurface,
    unused as spawnSurfaceClaimSequence, unused as agentLaunchTokenFor, unused as withAgentLaunchToken,
    unused as seedPtyLaunchTitle, unused as migratedPaneRestoreHint, unused as paneSize,
    unused as resolvePtyFirstSize, unused as resolveLaunchCommandPaneAgent };
`
)
const terminalReplacements = Object.fromEntries(
  [
    './terminal-launch-result',
    './terminal-create-reveal',
    './terminal-create-deduplication',
    '../../orca-runtime-create-terminal-dependencies',
    '../../orca-runtime-create-terminal-desktop',
    './terminal-create-team-allocation',
    '../../orca-runtime-report-pty-spawn-commit',
    '../../pty-recorded-surface-topology',
    '../../../agent-launch/agent-launch-token',
    './pty-launch-title',
    '../../migrated-pane-restore-cwd',
    '../../../ipc/pty/pty-first-size',
    '../../runtime-agent-launch-resolution'
  ].map((path) => [path, './terminal-ports.mjs'])
)
const { OrcaRuntimeWithCreateTerminal } = await moduleFromSource(
  'terminal-create.mjs',
  './terminal/launch/terminal-create.ts',
  {
    ...terminalReplacements,
    '../../worktree-custody-runtime': './runtime.mjs'
  }
)

writeFileSync(
  join(fixtureRoot, 'refusal-detail-ports.mjs'),
  `
  function unused() { throw new Error('unrelated refusal classification not reached'); }
  export { unused as readAgentCliInstallationProblem, unused as readCodexInstallationProblem,
    unused as readAgentSessionArgumentProblem, unused as isAgentJournalResolution };
  export const AGENT_SESSION_REWIND_REASONS = [];
  export const TUI_AGENT_DISPLAY_NAMES = {};
`
)
await moduleFromSource(
  'refusal-details.mjs',
  '../../shared/agent-session-refusal-details.ts',
  Object.fromEntries(
    [
      './agent-cli-installation-problem',
      './codex-cli-installation',
      './agent-session-argument-problem',
      './agent-session-journal-schemas',
      './agent-session-rewind',
      './tui-agent-display-names'
    ].map((path) => [path, './refusal-detail-ports.mjs'])
  )
)
await moduleFromSource('refusals.mjs', '../../shared/agent-session-wire-refusals.ts', {
  './agent-session-refusal-details': './refusal-details.mjs'
})

await moduleFromSource(
  'session-custody.mjs',
  '../native-chat/agent-session-wire/structured-agent-session-custody.ts',
  {
    '../../runtime/worktree-custody-runtime': './runtime.mjs',
    '../../../shared/agent-session-wire-refusals': './refusals.mjs'
  }
)
const sessionBoundaryImports = {
  './structured-agent-session-custody': './session-custody.mjs',
  '../../runtime/worktree-custody-runtime': './runtime.mjs',
  '../../../shared/agent-session-wire-refusals': './refusals.mjs'
}
const mutationBoundary = await boundaryModule(
  'mutation-boundary',
  '../native-chat/agent-session-wire/structured-agent-session-mutation-context.ts',
  sessionBoundaryImports
)
const attachBoundary = await boundaryModule(
  'attach-boundary',
  '../native-chat/agent-session-wire/structured-agent-session-attach-flow.ts',
  sessionBoundaryImports
)

writeFileSync(
  join(fixtureRoot, 'placement-ports.mjs'),
  `
  let worktree;
  export let creates = 0;
  export function configure(created) { worktree = created; creates = 0; }
  export async function executeAgentLaunch(args) { return args.workspaces.createWorktree({}); }
  export async function createWorkerWorktree() { creates++; return { worktree, terminalHandle: null }; }
  export async function tearDownFailedWorkerStart() {}
`
)
const placementPorts = await import(pathToFileURL(join(fixtureRoot, 'placement-ports.mjs')).href)
const { placeWorkerAgent } = await boundaryModule(
  'placement-boundary',
  './rpc/methods/orchestration/worker/worker-start-agent-placement.ts',
  {
    '../../../../worktree-custody-runtime': './runtime.mjs',
    '../../../../../agent-launch/agent-launch-executor': './placement-ports.mjs',
    './worker-worktree-creation': './placement-ports.mjs',
    './failed-worker-start-teardown': './placement-ports.mjs'
  }
)

export {
  runtimePorts,
  OrchestrationError,
  runtimeCustody,
  createCoreTablesSql,
  DISPATCH_CONTEXTS_SQL,
  WORKTREE_CUSTODY_METHOD,
  runtimeFixture,
  settleWorkerTerminalRelease,
  OrcaRuntimeWithCreateTerminal,
  mutationBoundary,
  attachBoundary,
  placementPorts,
  placeWorkerAgent
}

writeFileSync(
  join(fixtureRoot, 'interrupted-removal-runtime-ports.mjs'),
  `
  export const LOCAL_EXECUTION_HOST_ID = 'local';
  export const counts = { metadata: 0, list: 0 };
  let entered, reject, pending;
  export function setPending(value) { pending = value; }
  export function waitForPendingWorktreeRemoval() { return pending; }
  export function releaseStartupRemovalFence() {}
  export function prepare() { pending = undefined; counts.metadata = counts.list = 0; return new Promise(resolve => { entered = resolve; }); }
  export function fail() { reject(new Error('fixture list refusal')); }
  export function resolveWorktreeRemovalMetadata() { counts.metadata++; return null; }
  export function getLocalProjectWorktreeGitOptions() { return {}; }
  export function listWorktreesStrict() { counts.list++; entered(); return new Promise((_resolve, no) => { reject = no; }); }
`
)
const interruptedRemovalPorts = await import(
  pathToFileURL(join(fixtureRoot, 'interrupted-removal-runtime-ports.mjs')).href
)
const { interruptedLocalWorktreeRemovalJob } = await boundaryModule(
  'interrupted-removal',
  './runtime-interrupted-local-worktree-removal.ts',
  {
    './worktree-custody-runtime': './runtime.mjs',
    '../../shared/execution-host': './interrupted-removal-runtime-ports.mjs',
    '../worktree-removal-repo-owner': './interrupted-removal-runtime-ports.mjs',
    '../project-runtime-git-options': './interrupted-removal-runtime-ports.mjs',
    '../git/worktree': './interrupted-removal-runtime-ports.mjs',
    '../worktree-background-removal': './interrupted-removal-runtime-ports.mjs'
  }
)
export { interruptedRemovalPorts, interruptedLocalWorktreeRemovalJob }

const { failureLeftByGit } = await boundaryModule(
  'custody-removal-failure',
  '../worktree-removal-failure.ts',
  {
    './runtime/worktree-custody-records': './records.mjs'
  }
)
export { failureLeftByGit }
