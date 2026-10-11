import { existsSync, globSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const LEGACY_SOURCE = 'src/shared/child-process/'
const PACKAGE_NAME = '@orca/process-host'
const BASELINE_PATH = 'config/process-host-direct-import-baseline.txt'
const SOURCE_PATTERNS = [
  '*.{ts,tsx,mts,cts,js,mjs,cjs}',
  ...['src', 'config', 'tests', 'mobile/src', 'mobile/app', 'mobile/scripts'].map(
    (directory) => `${directory}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`
  )
]

function normalized(file) {
  return file.replaceAll('\\', '/')
}

// v1.4.224 has the legacy directory, not a package or package public-export boundary.
export function assessProcessHostImports(sources, baseline) {
  const direct = new Set()
  const violations = []
  for (const [sourceFile, contents] of sources) {
    const file = normalized(sourceFile)
    const production = !isTestOnlySourcePath(file)
    for (const sourceSpecifier of collectModuleSpecifiers(file, contents)) {
      const specifier = normalized(sourceSpecifier)
      const local = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
        : null
      const absolute = specifier.startsWith('file:')
        ? normalized(fileURLToPath(specifier))
        : path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier)
          ? specifier
          : null
      const absolutePackage =
        absolute &&
        path.posix
          .normalize(absolute)
          .split('/')
          .some(
            (part, index, parts) =>
              part === 'src' &&
              parts[index + 1] === 'packages' &&
              parts[index + 2] === 'process-host'
          )
      if (
        specifier === PACKAGE_NAME ||
        specifier.startsWith(`${PACKAGE_NAME}/`) ||
        local === 'src/packages/process-host' ||
        local?.startsWith('src/packages/process-host/') ||
        absolutePackage
      ) {
        violations.push(`${file}: ${sourceSpecifier} is absent in pre-extraction v1.4.224`)
      }
      if (production && file.startsWith(LEGACY_SOURCE)) {
        const bufferDependency =
          file === `${LEGACY_SOURCE}bounded-output-sink.ts` &&
          local === 'src/shared/growing-byte-buffer'
        if (!bufferDependency && !(local?.startsWith(LEGACY_SOURCE) || isBuiltin(specifier))) {
          violations.push(`${file}: legacy process helper cannot import ${sourceSpecifier}`)
        }
      } else if (
        production &&
        file.startsWith('src/') &&
        (specifier === 'child_process' || specifier === 'node:child_process')
      ) {
        direct.add(file)
      }
    }
  }
  const current = [...direct].sort()
  const baselineSet = new Set(baseline)
  return {
    direct: current,
    added: current.filter((file) => !baselineSet.has(file)),
    stale: baseline.filter((file) => !direct.has(file)).sort(),
    violations: violations.sort()
  }
}

export function readProcessHostBaseline(contents) {
  const entries = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (
    new Set(entries).size !== entries.length ||
    entries.some(
      (file) =>
        !file.startsWith('src/') ||
        file.includes('\\') ||
        path.posix.normalize(file) !== file ||
        file.startsWith(LEGACY_SOURCE) ||
        isTestOnlySourcePath(file)
    )
  ) {
    throw new Error('Invalid pre-extraction direct-import baseline')
  }
  return entries
}

export function collectProcessHostSources(root = ROOT) {
  return new Map(
    globSync(SOURCE_PATTERNS, {
      cwd: root,
      exclude: ['**/node_modules/**', '**/.*/**', '**/dist/**', '**/out/**', '**/build/**']
    })
      .map(normalized)
      .sort()
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')])
  )
}

export function main(root = ROOT) {
  const baseline = readProcessHostBaseline(readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
  const sources = collectProcessHostSources(root)
  if (existsSync(path.join(root, 'src/packages/process-host'))) {
    throw new Error('Unexpected process-host package; review the pre-extraction boundary migration')
  }
  for (const entry of [
    'run-process.ts',
    'fork-process.ts',
    'process-spec.ts',
    'spawn-resolution.ts',
    'process-tree-termination.ts',
    'spawn-observer.ts',
    'process-tree-kill-gate.ts'
  ]) {
    if (!sources.has(`${LEGACY_SOURCE}${entry}`)) {
      throw new Error(`Missing pre-extraction process implementation: ${entry}`)
    }
  }
  const result = assessProcessHostImports(sources, baseline)
  const failures = [
    ...result.violations,
    ...result.added.map((file) => `${file}: new direct child_process import; use ${LEGACY_SOURCE}`),
    ...result.stale.map((file) => `${file}: remove stale direct-import baseline entry`)
  ]
  if (failures.length > 0) {
    console.error(`[process-host-imports]\n${failures.join('\n')}`)
    return 1
  }
  console.log(
    `[process-host-imports] pre-extraction v1.4.224 ok; ${result.direct.length} legacy direct importers remain; package export isolation is not certified`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main()
}
