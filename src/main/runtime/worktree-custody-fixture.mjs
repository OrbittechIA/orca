import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import { afterAll as after } from 'vitest'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-custody-fixture-'))
after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

function moduleFromSource(name, source, replacements = {}) {
  let javascript = stripTypeScriptTypes(readFileSync(new URL(source, import.meta.url), 'utf8'), {
    mode: 'transform'
  })
  for (const [original, replacement] of Object.entries(replacements)) {
    javascript = javascript
      .replaceAll(`'${original}'`, `'${replacement}'`)
      .replaceAll(`"${original}"`, `"${replacement}"`)
  }
  const path = join(fixtureRoot, name)
  writeFileSync(path, javascript)
  return import(pathToFileURL(path).href)
}

const contract = await moduleFromSource('custody.mjs', '../../shared/worktree/custody.ts')
const custodyModules = {
  '../../shared/worktree/custody': './custody.mjs',
  ...Object.fromEntries(
    ['records', 'state', 'release-recovery', 'admission', 'fences'].map((name) => [
      `./worktree-custody-${name}`,
      `./${name}.mjs`
    ])
  )
}
for (const name of ['records', 'state', 'release-recovery', 'admission', 'fences']) {
  await moduleFromSource(`${name}.mjs`, `./worktree-custody-${name}.ts`, custodyModules)
}
const { WorktreeCustodyAuthority, CustodyPreEffectRefusal } = await moduleFromSource(
  'authority.mjs',
  './worktree-custody-authority.ts',
  custodyModules
)
const { WorktreeCustodyFileJournal } = await moduleFromSource(
  'journal.mjs',
  './worktree-custody-journal.ts',
  {
    '../../shared/worktree/custody': './custody.mjs'
  }
)
const BASE = {
  worktreeId: 'repo::/fixture/worktree',
  path: '/fixture/worktree',
  instanceId: 'instance-1',
  hostId: 'local',
  owner: 'orchestration',
  product: 'product-1',
  task: 'task-1'
}
const KEY = 'retirement_key_0001'

function setup(options = {}) {
  let durable = { records: [], receipts: [] }
  let now = 100_000
  let writes = 0
  let effects = 0
  let grantReleased = 0
  const journal = {
    read: () => structuredClone(durable),
    write: (records) => {
      writes++
      options.beforeWrite?.(writes, records)
      durable = structuredClone(records)
    }
  }
  let claims = { records: [], receipts: [] }
  const claimsJournal = {
    read: () => structuredClone(claims),
    write: (state) => {
      writes++
      options.beforeWrite?.(writes, state)
      claims = structuredClone(state)
    }
  }
  const authority = new WorktreeCustodyAuthority(journal, 'authority-1', () => now, claimsJournal)
  const resource = authority.claim(BASE, 'dispatch:1')
  const observation = () => ({
    resource,
    observedAt: now,
    disposition: 'released',
    releaseProof: 'producer-proof',
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: now,
      complete: true,
      active: false,
      held: false,
      proof: `native:${domain}`
    }))
  })
  const coverage = {
    observe: async () => (options.observe ? options.observe(observation()) : observation()),
    acquire: async () => {
      await options.acquire?.()
      let released = false
      return {
        check: () => !released && (options.check ? options.check() : true),
        release: () => {
          grantReleased++
          options.releaseGrant?.()
          released = true
        }
      }
    },
    retire: async (bound, check) => {
      check()
      effects++
      await options.effect?.(bound, check)
    },
    recoverFence: async (fence) =>
      options.recoverFence ? options.recoverFence(fence) : { fence, recovered: false, proof: null },
    reconcile: async (outcome) =>
      options.reconcile
        ? options.reconcile(outcome)
        : {
            resource: outcome.resource,
            key: outcome.key,
            confirmed: false,
            proof: null
          }
  }
  if (options.coverage !== false) {
    authority.installCoverage('orchestration', coverage)
  }
  if (options.release !== false) {
    authority.release('dispatch:1', 'native-release:1')
  }
  return {
    authority,
    resource,
    journal,
    claimsJournal,
    coverage,
    observation,
    advance: (ms) => {
      now += ms
    },
    effects: () => effects,
    writes: () => writes,
    grantReleased: () => grantReleased
  }
}

function completeObservation(resource) {
  return {
    resource,
    observedAt: Date.now(),
    disposition: 'unknown',
    releaseProof: null,
    domains: contract.WORKTREE_CUSTODY_DOMAINS.map((domain) => ({
      domain,
      observedAt: Date.now(),
      complete: true,
      active: false,
      held: false,
      proof: `owning:${domain}`
    }))
  }
}

async function boundaryModule(name, source, real) {
  const javascript = stripTypeScriptTypes(readFileSync(new URL(source, import.meta.url), 'utf8'), {
    mode: 'transform'
  })
  const exports = new Set()
  const replacements = { ...real }
  for (const match of javascript.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (real[match[2]]) {
      continue
    }
    replacements[match[2]] = `./${name}-ports.mjs`
    for (const field of match[1].split(',')) {
      exports.add(field.trim().split(/\s+as\s+/)[0])
    }
  }
  writeFileSync(
    join(fixtureRoot, `${name}-ports.mjs`),
    `function unreached() { throw new Error('session effect ran past custody refusal'); }\nexport { ${[...exports].map((key) => `unreached as ${key}`).join(', ')} };`
  )
  return moduleFromSource(`${name}.mjs`, source, replacements)
}

export {
  fixtureRoot,
  moduleFromSource,
  boundaryModule,
  contract,
  WorktreeCustodyAuthority,
  CustodyPreEffectRefusal,
  WorktreeCustodyFileJournal,
  BASE,
  KEY,
  setup,
  completeObservation
}
