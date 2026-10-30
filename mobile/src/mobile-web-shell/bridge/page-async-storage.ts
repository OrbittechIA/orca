import {
  isHostWorkspaceStorageKey,
  isPageStorageKeyForRoute,
  PAGE_STORAGE_MAX_VALUE_CHARS
} from '../page-storage-keys'
import {
  isWorkItemStartStorageKey,
  WORK_ITEM_START_ADMISSION_STORAGE_PREFIX
} from '../../storage/work-item-start-storage-key'

// Use init-primed native storage, not page localStorage (disabled on Android and session-scoped on iOS).
// Preferences use the init cache; Work Item Start writes await native persistence.
type PageStorageWriter = (key: string, value: string | null) => boolean

type PageStorageRefusal = 'not-allowed' | 'too-large' | 'not-delivered'

const REFUSAL_SENTENCES: Record<PageStorageRefusal, string> = {
  'not-allowed': 'this screen was not given that setting to write',
  'too-large': `a stored value may be at most ${String(PAGE_STORAGE_MAX_VALUE_CHARS)} characters`,
  'not-delivered': 'the app did not take the write'
}

// Reject only too-large writes: the durable journal’s composer catches that to prevent mutations with unpersisted operation ids (ruling 7).
// Unlisted/ungranted preferences drop silently because their callers have no rejection handlers; log the refusal instead (ruling 33.4).
export class PageStorageRefusedError extends Error {
  readonly refusal: PageStorageRefusal
  readonly key: string

  constructor(key: string, refusal: PageStorageRefusal) {
    super(`Orca could not save ${key}: ${REFUSAL_SENTENCES[refusal]}.`)
    this.name = 'PageStorageRefusedError'
    this.refusal = refusal
    this.key = key
  }
}

const values = new Map<string, string>()
let write: PageStorageWriter = () => false
// Refuse withheld oversized keys as too-large: the page holds no starting value, so any write would overwrite rather than extend the native value (ruling 33.6).
let oversizeKeys: ReadonlySet<string> = new Set()
let hostId = ''
let routePathname = ''
let hostArea = false
// Start recovery reads on demand; other workspace keys require host-area ownership.
let readWorkspaceKey: ((key: string) => Promise<string | null>) | null = null
let persist: ((key: string, expectedValue: string | null, value: string) => Promise<void>) | null =
  null

export function publishPageStorage(
  entries: Readonly<Record<string, string>>,
  writer: PageStorageWriter,
  forHostId: string,
  forRoutePathname: string,
  forOversizeKeys: readonly string[] = [],
  forWorkspaceKeyReader: ((key: string) => Promise<string | null>) | null = null,
  forDurableWriter: typeof persist = null,
  forHostArea = forWorkspaceKeyReader !== null
): void {
  values.clear()
  oversizeKeys = new Set(forOversizeKeys)
  for (const [key, value] of Object.entries(entries)) {
    values.set(key, value)
  }
  write = writer
  hostId = forHostId
  routePathname = forRoutePathname
  readWorkspaceKey = forWorkspaceKeyReader
  persist = forDurableWriter
  hostArea = forHostArea
}

async function getItem(key: string): Promise<string | null> {
  const onDemand =
    readWorkspaceKey !== null &&
    ((hostArea && isHostWorkspaceStorageKey(key, hostId)) || isWorkItemStartStorageKey(key))
  if (isWorkItemStartStorageKey(key) && oversizeKeys.has(key) && !onDemand)
    throw new PageStorageRefusedError(key, 'too-large')
  const value =
    onDemand && readWorkspaceKey !== null ? await readWorkspaceKey(key) : (values.get(key) ?? null)
  if (value !== null) values.set(key, value)
  else values.delete(key)
  return value
}

async function setItem(key: string, value: string): Promise<void> {
  if (!isWorkItemStartStorageKey(key)) return settle(key, accept(key, value))
  if (key.startsWith(WORK_ITEM_START_ADMISSION_STORAGE_PREFIX) && readWorkspaceKey === null)
    throw new PageStorageRefusedError(key, 'not-allowed')
  if (!isPageStorageKeyForRoute(key, hostId, routePathname, hostArea))
    throw new PageStorageRefusedError(key, 'not-allowed')
  if (value.length > PAGE_STORAGE_MAX_VALUE_CHARS || oversizeKeys.has(key))
    throw new PageStorageRefusedError(key, 'too-large')
  if (persist === null) throw new PageStorageRefusedError(key, 'not-delivered')
  await persist(key, values.get(key) ?? null, value)
  values.set(key, value)
}

// Never keep refused writes locally; an app-invisible cache value would make a pin appear persisted only to this document.
function accept(key: string, value: string | null): PageStorageRefusal | null {
  if (!isPageStorageKeyForRoute(key, hostId, routePathname, hostArea)) {
    return 'not-allowed'
  }
  // Use the envelope’s bound so cached values cannot exceed what the shell will write.
  if (value !== null && value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
    return 'too-large'
  }
  // Withheld oversized app values are unwritable too; without their initial contents a page write is destructive replacement.
  if (oversizeKeys.has(key)) {
    return 'too-large'
  }
  if (!write(key, value)) {
    return 'not-delivered'
  }
  if (value === null) {
    values.delete(key)
  } else {
    values.set(key, value)
  }
  return null
}

// Log refused writes but build plain errors first; discarded rejected promises would create unhandled rejections before the caller chooses its outcome.
function refusalError(
  key: string,
  refusal: PageStorageRefusal | null
): PageStorageRefusedError | null {
  if (refusal === null) {
    return null
  }
  if (refusal === 'too-large') {
    return new PageStorageRefusedError(key, refusal)
  }
  console.warn('[page-bridge] storage-write-dropped', { key, refusal })
  return null
}

function settle(key: string, refusal: PageStorageRefusal | null): Promise<void> {
  const error = refusalError(key, refusal)
  return error === null ? Promise.resolve() : Promise.reject(error)
}

// Apply pairs in order and stop at the first refusal: one batch has one result, not a reported failure mixed with later successful writes (ruling 35).
async function applyBatch(pairs: readonly (readonly [string, string | null])[]): Promise<void> {
  for (const [key, value] of pairs) {
    if (isWorkItemStartStorageKey(key) && value !== null) {
      await setItem(key, value)
      continue
    }
    const refusal = accept(key, value)
    if (refusal !== null) {
      return settle(key, refusal)
    }
  }
  return Promise.resolve()
}

const pageAsyncStorage = {
  getItem,
  setItem,
  removeItem: (key: string): Promise<void> => settle(key, accept(key, null)),
  multiGet: (keys: readonly string[]): Promise<[string, string | null][]> =>
    Promise.all(
      keys.map(async (key): Promise<[string, string | null]> => [key, await getItem(key)])
    ),
  multiSet: (pairs: readonly [string, string][]): Promise<void> => applyBatch(pairs),
  multiRemove: (keys: readonly string[]): Promise<void> =>
    applyBatch(keys.map((key) => [key, null] as const)),
  getAllKeys: (): Promise<string[]> => Promise.resolve([...values.keys()]),
  clear: (): Promise<void> => Promise.resolve()
}

export default pageAsyncStorage
