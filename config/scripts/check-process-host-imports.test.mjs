import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

function specifiers(contents) {
  return collectModuleSpecifiers('file.ts', contents)
}

describe('static module specifiers', () => {
  it.each([
    [
      'a direct createRequire call',
      "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('child_process')"
    ],
    [
      'an assigned createRequire loader',
      "import { createRequire } from 'node:module'\nconst load = createRequire(__filename)\nload('node:child_process')"
    ],
    [
      'a renamed createRequire import',
      "import { createRequire as make } from 'module'\nconst load = make(__filename)\nload.resolve('child_process')"
    ],
    [
      'a namespace createRequire',
      "import * as nodeModule from 'node:module'\nnodeModule.createRequire(__filename)('child_process')"
    ],
    [
      'a default-import createRequire',
      "import Module from 'module'\nconst load = Module.createRequire(__filename)\nload('child_process')"
    ],
    [
      'a named default-import createRequire',
      "import { default as Module } from 'node:module'\nModule.createRequire(__filename)('child_process')"
    ],
    [
      'a named Module constructor',
      "import { Module } from 'node:module'\nModule.createRequire(__filename)('child_process')"
    ],
    [
      'a renamed Module constructor',
      "import { Module as HostModule } from 'module'\nHostModule.createRequire(__filename)('node:child_process')"
    ],
    [
      'an import-equals createRequire',
      "import Module = require('node:module')\nconst load = Module.createRequire(__filename)\nload('node:child_process')"
    ],
    [
      'a literal-property createRequire',
      "import * as Module from 'node:module'\nModule['createRequire'](__filename)('child_process')"
    ],
    [
      'a required createRequire',
      "const { createRequire: make } = require('node:module')\nmake(__filename)('child_process')"
    ],
    [
      'a quoted destructured createRequire',
      "const { 'createRequire': make } = require('node:module')\nmake(__filename)('child_process')"
    ],
    [
      'a chained module alias',
      "const nodeModule = require('module')\nconst load = nodeModule.createRequire(__filename)\nload('child_process')"
    ],
    [
      'an awaited module import',
      "const { createRequire } = await import('node:module')\ncreateRequire(import.meta.url)('child_process')"
    ],
    ['a reassigned require', "const load = require\nload('child_process')"],
    ['module.require', "module.require('child_process')"],
    ['a literal-property module.require', "module['require']('child_process')"],
    ['a literal-property require.resolve', "require['resolve']('child_process')"],
    ['process.getBuiltinModule', "process.getBuiltinModule('node:child_process')"],
    ['a literal-property getBuiltinModule', "process['getBuiltinModule']('node:child_process')"],
    ['a template-property getBuiltinModule', 'process[`getBuiltinModule`]("child_process")'],
    ['globalThis.process.getBuiltinModule', "globalThis.process.getBuiltinModule('child_process')"],
    [
      'literal properties on globalThis.process',
      "globalThis['process']['getBuiltinModule']('child_process')"
    ],
    [
      'an imported process',
      "import nodeProcess from 'node:process'\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'a named default-import process',
      "import { default as nodeProcess } from 'node:process'\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'an import-equals process',
      "import nodeProcess = require('node:process')\nnodeProcess.getBuiltinModule('child_process')"
    ],
    [
      'a destructured getBuiltinModule',
      "const { getBuiltinModule } = process\ngetBuiltinModule('child_process')"
    ],
    [
      'a quoted destructured getBuiltinModule',
      "const { 'getBuiltinModule': load } = process\nload('child_process')"
    ],
    [
      'a builtin module with a literal-property factory',
      "process['getBuiltinModule']('node:module')['createRequire'](__filename)('child_process')"
    ],
    [
      'an imported getBuiltinModule',
      "import { getBuiltinModule as load } from 'process'\nload('child_process')"
    ],
    [
      'a const specifier',
      "const CHILD_PROCESS = 'node:child_process' as const\nrequire(CHILD_PROCESS)"
    ],
    [
      'a const template specifier',
      'const CHILD_PROCESS = `child_process`\nprocess.getBuiltinModule(CHILD_PROCESS)'
    ]
  ])('resolves child_process loaded through %s', (_label, contents) => {
    expect(
      specifiers(contents).filter((specifier) => specifier.endsWith('child_process'))
    ).toHaveLength(1)
  })

  it('ignores unrelated objects, computed property values, and non-constant specifiers', () => {
    expect(
      specifiers(
        [
          'const registry = { getBuiltinModule: (name) => name, createRequire: () => () => null }',
          "registry.getBuiltinModule('child_process')",
          "registry.createRequire(__filename)('child_process')",
          "registry['getBuiltinModule']('child_process')",
          "registry['createRequire'](__filename)('child_process')",
          "const method = 'getBuiltinModule'",
          "process[method]('child_process')",
          "let mutable = 'child_process'",
          'require(mutable)',
          "require('child' + '_process')",
          "const name = 'child'",
          'require(`${name}_process`)'
        ].join('\n')
      )
    ).toEqual([])
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assessProcessHostImports,
  collectProcessHostSources,
  main,
  readProcessHostBaseline
} from './check-process-host-imports.mjs'

const roots = []
const legacy = 'src/shared/child-process/'
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function assess(files, baseline = []) {
  return assessProcessHostImports(new Map(Object.entries(files)), baseline)
}
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-process-boundary-'))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return root
}
function implementation() {
  return Object.fromEntries(
    [
      'run-process',
      'fork-process',
      'process-spec',
      'spawn-resolution',
      'process-tree-termination',
      'spawn-observer',
      'process-tree-kill-gate'
    ].map((name) => [`${legacy}${name}.ts`, 'export const present = true'])
  )
}

describe('pre-extraction process boundary', () => {
  it('reads imports, reexports and loaders without parsing embedded programs as source', () => {
    expect(
      collectModuleSpecifiers(
        'file.ts',
        [
          "// import 'node:child_process'",
          'const script = String.raw`require("node:child_process")`',
          'const text = "import \'child_process\'"',
          "import type { ChildProcess } from 'node:child_process'",
          "export { spawn } from 'child_process'",
          "type Child = import('type-only').Child",
          "import legacy = require('legacy')",
          "import('dynamic'); require('required'); require.resolve('resolved')"
        ].join('\n')
      )
    ).toEqual([
      'node:child_process',
      'child_process',
      'type-only',
      'legacy',
      'dynamic',
      'required',
      'resolved'
    ])
  })
  it.each(['broken.ts', 'broken.tsx', 'broken.js', 'broken.mjs'])(
    'fails closed on malformed %s',
    (file) => {
      expect(() => assess({ [file]: 'import {' })).toThrow(`Cannot parse ${file}`)
    }
  )
  it('allows only existing debt and implementation imports, excluding test-only raw callers', () => {
    expect(
      assess(
        {
          [`${legacy}run-process.ts`]: "import 'node:child_process'",
          [`${legacy}run-process.test.ts`]: "import 'vitest'; import 'child_process'",
          'src/main/old.ts': "export type { ChildProcess } from 'child_process'",
          'src/main/old.test.ts': "import 'child_process'",
          'src/main/__fixtures__/old.ts': "import 'child_process'",
          'config/scripts/build.mjs': "import 'child_process'"
        },
        ['src/main/old.ts']
      )
    ).toEqual({ direct: ['src/main/old.ts'], added: [], stale: [], violations: [] })
  })
  it.each([
    "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); load('node:child_process')",
    "import { default as Module } from 'node:module'; Module.createRequire(import.meta.url)('child_process')",
    "const { getBuiltinModule: load } = process; load('node:child_process')"
  ])('enforces production debt through resolved AST loaders: %s', (contents) => {
    expect(assess({ 'src/main/new.ts': contents }).added).toEqual(['src/main/new.ts'])
  })
  it('reports new imports and deleted, renamed or migrated debt as stale', () => {
    expect(assess({ 'src/main/new.ts': "require('child_process')" }, ['src/main/old.ts'])).toEqual({
      direct: ['src/main/new.ts'],
      added: ['src/main/new.ts'],
      stale: ['src/main/old.ts'],
      violations: []
    })
  })
  it.each([
    '@orca/process-host',
    '@orca/process-host/process-spec',
    '@orca/process-host/private',
    '../packages/process-host',
    '../packages/process-host/src/runner',
    '../packages/process-host/src/../runner',
    '..\\packages\\process-host\\src\\runner',
    '@orca\\process-host\\process-spec'
  ])('rejects unavailable package reference %s even in tests', (specifier) => {
    expect(
      assess({ 'src/main/consumer.test.ts': `require(${JSON.stringify(specifier)})` }).violations
    ).toHaveLength(1)
  })
  it.each([
    ['src/main/consumer.ts', '/repo/src/packages/process-host/src/run-process'],
    ['config/scripts/consumer.mjs', 'file:///repo/src/packages/process-host/dist/run-process.js'],
    ['mobile/src/consumer.ts', 'C:\\repo\\src\\packages\\process-host\\src\\runner'],
    ['src/main/consumer.test.ts', 'file:///C:/repo/src/packages/process-host/src/run-process']
  ])('rejects absolute unavailable package access in %s', (file, specifier) => {
    expect(assess({ [file]: `require(${JSON.stringify(specifier)})` }).violations).toHaveLength(1)
  })
  it('preserves exactly the existing byte-buffer dependency', () => {
    expect(
      assess({ [`${legacy}bounded-output-sink.ts`]: "import '../growing-byte-buffer'" }).violations
    ).toEqual([])
    expect(
      assess({ [`${legacy}other.ts`]: "import '../growing-byte-buffer'" }).violations
    ).toHaveLength(1)
  })
  it.each([
    'electron',
    '../../../main/runtime',
    '/absolute/runner',
    'C:\\runner.ts',
    'third-party'
  ])('rejects helper dependency %s', (specifier) => {
    expect(
      assess({ [`${legacy}runner.ts`]: `import ${JSON.stringify(specifier)}` }).violations
    ).toHaveLength(1)
  })
  it.each([
    'src/main/a.ts\nsrc/main/a.ts',
    '../a.ts',
    'src/main/../a.ts',
    'src/main/a.test.ts',
    'src/shared/child-process/runner.ts'
  ])('rejects malformed baseline %s', (contents) => {
    expect(() => readProcessHostBaseline(contents)).toThrow('Invalid pre-extraction')
  })
  it('enforces present implementations, new/stale debt and parse errors through the real entry', () => {
    const root = fixture({
      ...implementation(),
      'config/process-host-direct-import-baseline.txt': 'src/main/old.ts\n',
      'src/main/old.ts': "import 'child_process'"
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main(root)).toBe(0)
    writeFileSync(path.join(root, 'src/main/old.ts'), 'export const migrated = true')
    expect(main(root)).toBe(1)
    writeFileSync(path.join(root, 'src/main/new.ts'), "import 'child_process'")
    expect(main(root)).toBe(1)
    writeFileSync(path.join(root, 'src/main/new.ts'), 'import {')
    expect(() => main(root)).toThrow('Cannot parse')
    rmSync(path.join(root, `${legacy}run-process.ts`))
    expect(() => main(root)).toThrow('Missing pre-extraction')
  })
  it('rejects a planted package implementation and a missing baseline', () => {
    const root = fixture({
      ...implementation(),
      'config/process-host-direct-import-baseline.txt': '',
      'src/packages/process-host/package.json': '{}'
    })
    expect(() => main(root)).toThrow('Unexpected process-host package')
    rmSync(path.join(root, 'config/process-host-direct-import-baseline.txt'))
    expect(() => main(root)).toThrow()
  })
  it('excludes dependency and generated trees while scanning mobile and config source', () => {
    const root = fixture({
      'config/scripts/real.mjs': 'export {}',
      'mobile/src/real.tsx': 'export {}',
      'src/dist/ignored.ts': 'import {',
      'src/node_modules/ignored.ts': 'import {',
      'src/.hidden/ignored.ts': 'import {'
    })
    expect([...collectProcessHostSources(root).keys()]).toEqual([
      'config/scripts/real.mjs',
      'mobile/src/real.tsx'
    ])
  })
})
