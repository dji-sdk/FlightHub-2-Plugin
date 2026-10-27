// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// @vitest-environment node

import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(sdkRoot, '../..')
let directory: string
let packageRoot: string

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'fh2-sdk-declarations-')))
  packageRoot = join(directory, 'node_modules/fh2-plugin-sdk')
  mkdirSync(packageRoot, { recursive: true })
  // Only published artifacts are available to the consumer, never SDK source or workspace paths.
  cpSync(join(sdkRoot, 'dist'), join(packageRoot, 'dist'), { recursive: true })
  copyFileSync(join(sdkRoot, 'package.json'), join(packageRoot, 'package.json'))
  copyFileSync(join(sdkRoot, 'runtime-contract.json'), join(packageRoot, 'runtime-contract.json'))
})

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

const typeAssertions = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
`

describe('built SDK exports', () => {
  it.each([
    {
      subpath: '.',
      source: `
import { definePlugin, manifestSchema, runtimeContract } from 'fh2-plugin-sdk'
import manifestSchemaJson from 'fh2-plugin-sdk/schema/manifest.schema.json' with { type: 'json' }
import runtimeContractJson from 'fh2-plugin-sdk/runtime-contract.json' with { type: 'json' }

export type SchemaInference = Assert<Equal<typeof manifestSchema, typeof manifestSchemaJson>>
export type RuntimeContractInference = Assert<Equal<typeof runtimeContract, typeof runtimeContractJson>>
definePlugin({ activate(ctx) { const id: string = ctx.host.id; void id } })
`,
    },
    {
      subpath: 'view',
      source: `
import { createViewState, defineView, type ViewInstance } from 'fh2-plugin-sdk/view'

const state = createViewState({ count: 0 })
state.update(current => ({ count: current.count + 1 }))
export type StateInference = Assert<Equal<ReturnType<typeof state.get>, { count: number }>>
const view = defineView({ mount(ctx) {
  const element: HTMLElement = ctx.mountElement
  const port: MessagePort = ctx.port
  void port
  return { dispose() { element.remove() } }
} })
export type ViewInference = Assert<Equal<ReturnType<typeof view>, Promise<ViewInstance>>>
`,
    },
    {
      subpath: 'catalog',
      source: `
import { HOST_IDS, type HostId } from 'fh2-plugin-sdk/catalog'

const host: HostId = HOST_IDS[0]
export type HostInference = Assert<Equal<typeof HOST_IDS[number], HostId>>
void host
`,
    },
    {
      subpath: 'backend',
      source: `
import type { HandlerCtx } from 'fh2-plugin-sdk/backend'

declare const ctx: HandlerCtx
const id = ctx.stableId('declarations')
export type IdInference = Assert<Equal<typeof id, string>>
`,
    },
    {
      subpath: 'generator',
      source: `
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'

declare const manifest: PluginManifest
const generated = generatePluginTypes({ manifest, outDir: process.cwd() })
export type FileNameInference = Assert<Equal<typeof generated.fileName, 'plugin-types.ts'>>
export type SourceInference = Assert<Equal<typeof generated.source, string>>
`,
    },
  ])('$subpath declarations compile for a strict consumer', ({ subpath, source }) => {
    const node = subpath === 'generator'
    const fileName = join(directory, `consumer-${subpath === '.' ? 'index' : subpath}.mts`)
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: node ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
      moduleResolution: node ? ts.ModuleResolutionKind.NodeNext : ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: node ? ['node'] : [],
      ...(node ? { typeRoots: [join(repositoryRoot, 'node_modules/@types')] } : {}),
      resolveJsonModule: true,
      esModuleInterop: true,
    }
    const compilerHost = ts.createCompilerHost(options)
    const consumerSource = typeAssertions + source
    const host: ts.CompilerHost = {
      ...compilerHost,
      fileExists: path => path === fileName || compilerHost.fileExists(path),
      readFile: path => path === fileName ? consumerSource : compilerHost.readFile(path),
      getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) => path === fileName
        ? ts.createSourceFile(path, consumerSource, languageVersion, true)
        : compilerHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
    }
    const specifier = `fh2-plugin-sdk${subpath === '.' ? '' : `/${subpath}`}`
    const resolved = ts.resolveModuleName(specifier, fileName, options, host).resolvedModule
    expect(resolved?.resolvedFileName).toBe(join(packageRoot, 'dist', subpath, 'index.d.ts'))

    const program = ts.createProgram([fileName], options, host)
    const diagnostics = ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
      getCurrentDirectory: () => directory,
      getCanonicalFileName: path => path,
      getNewLine: () => '\n',
    })
    expect(diagnostics).toBe('')
  }, 30_000)

  it('preserves the built runtime contract and manifest schema JSON', async () => {
    const sdk = await import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
    const runtimeContract = readFileSync(join(sdkRoot, 'runtime-contract.json'), 'utf8')
    const schema = readFileSync(join(sdkRoot, 'src/schema/manifest.schema.json'), 'utf8')
    expect(sdk.runtimeContract).toEqual(JSON.parse(runtimeContract))
    expect(sdk.manifestSchema).toEqual(JSON.parse(schema))
    expect(sdk.MANIFEST_SCHEMA_ID).toBe(sdk.manifestSchema.$id)
    expect(readFileSync(join(packageRoot, 'dist/schema/manifest.schema.json'), 'utf8')).toBe(schema)
  })
})
