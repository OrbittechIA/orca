import {
  fixtureRoot,
  moduleFromSource,
  contract,
  WorktreeCustodyAuthority,
  BASE,
  nativePorts,
  installNativeWorktreeCustodyRetirement
} from './worktree-custody-fixture.mjs'

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
