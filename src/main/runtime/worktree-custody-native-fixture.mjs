import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fixtureRoot,
  moduleFromSource,
  contract,
  WorktreeCustodyAuthority,
  BASE,
  nativePorts,
  installNativeWorktreeCustodyRetirement
} from './worktree-custody-fixture.mjs'
import { createCoreTablesSql } from './worktree-custody-runtime-fixture.mjs'

function nativeFixture(path, nativeHold = false, options = {}) {
  nativePorts.setClean(() => {})
  let releasedGrants = 0
  let durable = { records: [], receipts: [] }
  const authority = new WorktreeCustodyAuthority(
    {
      read: () => durable,
      write: (records) => {
        durable = structuredClone(records)
      }
    },
    'native-fixture-authority',
    options.now ?? Date.now
  )
  const resource = authority.claim(
    { ...BASE, path, worktreeId: `repo::${path}` },
    `dispatch:${path}`
  )
  const proof = (bound) => ({
    resource: bound,
    observedAt: Date.now(),
    disposition: 'unknown',
    releaseProof: null,
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: Date.now(),
      complete: true,
      active: domain === 'workspace' && nativeHold,
      held: false,
      proof: `native:${domain}`
    }))
  })
  const history = { chats: ['retained'], branches: ['retained'], session: ['retained'] }
  const runtime = {
    getRuntimeId: () => 'native-runtime-fixture',
    observeNative: proof,
    showManagedWorktree: async () => ({
      id: resource.worktreeId,
      path,
      instanceId: BASE.instanceId,
      hostId: 'local',
      projectId: BASE.product,
      isMainWorktree: false,
      isBare: false,
      childWorktreeIds: [],
      git: { path, head: 'preserved-head' }
    }),
    showRepo: async () => ({ kind: 'git', path: fixtureRoot }),
    stopPtys: () => {
      throw new Error('a no-stop operation cannot invoke teardown')
    },
    closeTerminal: () => {
      throw new Error('a no-stop operation cannot close sessions')
    },
    history
  }
  installNativeWorktreeCustodyRetirement(runtime, {
    owner: BASE.owner,
    observe: async (bound) => ({
      ...proof(bound),
      domains: proof(bound).domains.map((entry) => ({ ...entry, active: false }))
    }),
    acquire: async () => ({
      check: () => true,
      release: () => {
        releasedGrants++
        options.releaseGrant?.()
      }
    }),
    recoverFence: async (fence) => ({ fence, recovered: false, proof: null }),
    reconcile: async (outcome) => ({
      resource: outcome.resource,
      key: outcome.key,
      confirmed: false,
      proof: null
    })
  })
  const coverage = nativePorts.installedCoverage()
  authority.installCoverage(BASE.owner, options.coverage ? options.coverage(coverage) : coverage)
  authority.release(`dispatch:${path}`, `native-worker-release:${path}`)
  return {
    authority,
    resource,
    runtime,
    journal: {
      read: () => structuredClone(durable),
      write: (state) => {
        durable = structuredClone(state)
      }
    },
    grantReleased: () => releasedGrants
  }
}

const { observeNativeWorktreeCustody } = await moduleFromSource(
  'observation.mjs',
  './worktree-custody-observation.ts',
  {
    '../../shared/worktree/custody': './custody.mjs',
    '../native-chat/agent-session-wire/structured-agent-session-registry': './native-ports.mjs',
    '../worktree-removal-table': './native-ports.mjs',
    './worktree-custody-runtime': './native-ports.mjs'
  }
)

export { nativePorts, nativeFixture, observeNativeWorktreeCustody }

writeFileSync(
  join(fixtureRoot, 'provider-ports.mjs'),
  `
  export function normalizeRuntimePathForComparison(value) { return value; }
  export function isPathInsideOrEqual(root, candidate) {
    return candidate === root || candidate.startsWith(root.endsWith('/') ? root : root + '/');
  }
  export const TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE = 'terminal removal in progress';
  export const WATCHER_REMOVAL_IN_PROGRESS_MESSAGE = 'watcher removal in progress';
  export function getStructuredAgentSessionHost() { return null; }
  export const pendingWorktreeRemovals = new Map();
  export const failedWorktreeRemovals = new Map();
  export const watcherLifecycleState = {
    watchedRoots: new Map(), suspendedLocalWatcherListeners: new Map(),
    inFlightLocalInstalls: new Map(), pendingLocalInstallPromises: new Map()
  };
  export function isWatcherProcessFailure() { return false; }
  export async function gitExecFileAsync() { throw new Error('production git is not reached by fixtures'); }
  let authority = null;
  export function setAuthority(next) { authority = next; }
  export function nativeWorktreeCustody() { return authority; }
`
)
const providerPorts = await import(pathToFileURL(join(fixtureRoot, 'provider-ports.mjs')).href)
const gate = await moduleFromSource('watcher-gate.mjs', '../ipc/watcher-removal-gate.ts', {
  '../../shared/cross-platform-path': './provider-ports.mjs',
  '../../shared/worktree/removal-fence-error': './provider-ports.mjs'
})
const { proveWorktreePreservation } = await moduleFromSource(
  'preservation.mjs',
  './worktree-custody-preservation.ts',
  { '../git/runner': './provider-ports.mjs' }
)
// The actual runtime file-watch lease registry, so inventory gaps cannot hide behind a port.
const leases = await moduleFromSource(
  'file-watcher-leases.mjs',
  './files/watch/file-watcher-leases.ts',
  {
    '../../../../shared/cross-platform-path': './provider-ports.mjs',
    '../../../ipc/filesystem/watcher-process/parcel-watcher-process-failure': './provider-ports.mjs'
  }
)
const providerCore = await moduleFromSource(
  'native-provider.mjs',
  './worktree-custody-native-provider.ts',
  { '../../shared/cross-platform-path': './provider-ports.mjs' }
)
const providerHost = await moduleFromSource(
  'native-provider-host.mjs',
  './worktree-custody-native-provider-host.ts',
  {
    '../native-chat/agent-session-wire/structured-agent-session-registry': './provider-ports.mjs',
    '../worktree-removal-table': './provider-ports.mjs',
    '../ipc/filesystem/watchers/filesystem-watcher-lifecycle-state': './provider-ports.mjs',
    './files/watch/file-watcher-leases': './file-watcher-leases.mjs',
    '../ipc/watcher-removal-gate': './watcher-gate.mjs',
    './worktree-custody-preservation': './preservation.mjs',
    './worktree-custody-runtime': './provider-ports.mjs',
    './worktree-custody-retirement': './retirement.mjs',
    './worktree-custody-native-provider': './native-provider.mjs'
  }
)
const provider = { ...providerCore, ...providerHost }

/** Git answers for a checkout whose only material is tracked, clean and on a retained branch. */
function cleanGit(path, overrides = {}) {
  const answers = {
    'rev-parse --show-toplevel': `${path}\n`,
    status: '',
    'ls-files -v': 'H tracked-source\0',
    'ls-files --stage': '100644 0123456789abcdef0123456789abcdef01234567 0\ttracked-source\0',
    'symbolic-ref -q': 'refs/heads/feature\n',
    'rev-parse --verify': `${'a'.repeat(40)}\n`,
    'for-each-ref': '',
    'rev-parse --absolute-git-dir': `${path}/.fixture-git-dir\n`,
    ...overrides
  }
  return async (args) => {
    const key = Object.keys(answers)
      .filter((prefix) => args.join(' ').startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0]
    const answer = answers[key]
    if (answer instanceof Error) {
      throw answer
    }
    if (answer === undefined) {
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    return answer
  }
}

const RELEASED_LEASE = {
  claimStatus: 'released',
  unreconciled: false,
  handoffStage: null,
  reservedSpawnToken: null
}

/** Real authority, native observation, watcher gate and provider; only host stores are in memory. */
async function providerFixture(checkout, options = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(createCoreTablesSql())
  for (const state of options.workers ?? ['succeeded']) {
    sqlite
      .prepare('INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES (?, ?, ?)')
      .run(`dispatch-${state}`, state, `repo::${checkout}`)
  }
  nativePorts.setClean(() => {})
  let durable = { records: [], receipts: [] }
  const authority = new WorktreeCustodyAuthority(
    { read: () => durable, write: (state) => (durable = structuredClone(state)) },
    options.authorityId ?? 'provider-fixture-authority',
    Date.now,
    options.claims
  )
  const worktreeId = `repo::${checkout}`
  const resource = authority.claim(
    { ...BASE, path: checkout, worktreeId, ...options.claim },
    `dispatch:${checkout}`
  )
  const session = {
    activeWorktreeId: null,
    sleepingAgentSessionsByPaneKey: {},
    openFilesByWorktree: {},
    ...options.session
  }
  const records = options.records ?? [
    { sessionId: 'finished-session', location: { workspaceId: worktreeId }, lease: RELEASED_LEASE }
  ]
  const runtime = {
    getRuntimeId: () => 'provider-fixture-runtime',
    showManagedWorktree: async () => ({
      id: worktreeId,
      repoId: 'repo',
      path: checkout,
      instanceId: BASE.instanceId,
      hostId: 'local',
      projectId: options.physicalProject ?? BASE.product,
      isMainWorktree: false,
      isBare: false,
      workspaceStatus: 'completed',
      isPinned: false,
      childWorktreeIds: [],
      git: { path: checkout, head: 'preserved-head' }
    }),
    showRepo: async () => ({ kind: 'git', path: fixtureRoot }),
    getWorkspaceSessionForWorktree: () => session,
    requireStore: () => ({ getWorkspaceSession: () => ({ activeWorktreeId: null }) }),
    listTerminals: async () => ({
      terminals: [],
      totalCount: 0,
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: [] }
    }),
    openedAgentSessionRecordStore: () => ({ listRecords: () => records }),
    getOrchestrationDb: () => ({
      db: { prepare: (sql) => sqlite.prepare(sql) },
      listWorkerTerminalResources: () => [
        {
          worktreeId,
          dispatchStatus: 'completed',
          terminalState: 'released',
          pendingInput: false,
          pendingApproval: false
        }
      ]
    })
  }
  runtime.observeNative = (bound) => observeNativeWorktreeCustody(runtime, bound)
  let externalReleases = 0
  const ports = {
    runtime,
    structuredWork: () => undefined,
    removals: () => [...providerPorts.pendingWorktreeRemovals.values()],
    desktopWatchRoots: () =>
      [...providerPorts.watcherLifecycleState.watchedRoots.values()].map((root) => root.rootPath),
    runtimeWatchLeases: (path) => leases.countRuntimeFileWatcherLeasesOverlapping(path),
    fenceInstalls: (path) => gate.acquireWatcherRemovalGate(path),
    preservation: (path) => proveWorktreePreservation(path, cleanGit(path, options.git)),
    // Stand in for the paired-selection and external-consumer authorities this host does not have.
    pairedSelection: options.external === null ? null : { selects: () => false },
    external:
      options.external === null
        ? null
        : {
            observe: async () => ({
              observedAt: Date.now(),
              complete: true,
              active: false,
              held: false,
              proof: 'qualified-external-authority'
            }),
            acquire: async () => ({ check: () => true, release: () => externalReleases++ })
          }
  }
  const created = provider.createNativeWorktreeCustodyProvider(ports)
  if (created.ready) {
    installNativeWorktreeCustodyRetirement(runtime, created)
    authority.installCoverage(created.owner, nativePorts.installedCoverage())
  }
  return {
    authority,
    resource,
    provider: created,
    runtime,
    sqlite,
    externalReleases: () => externalReleases
  }
}

function providerCheckout(name) {
  const checkout = mkdtempSync(join(fixtureRoot, `provider-${name}-`))
  writeFileSync(join(checkout, 'tracked-source'), 'fixture source')
  return checkout
}

export {
  providerPorts,
  gate,
  leases,
  provider,
  proveWorktreePreservation,
  cleanGit,
  RELEASED_LEASE,
  providerFixture,
  providerCheckout
}
