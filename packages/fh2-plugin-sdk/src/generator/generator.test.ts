// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import ts from 'typescript'
import type { PluginManifest } from '../contracts/index.js'
import { generatePluginTypes } from './index.js'

const manifest: PluginManifest = {
  id: 'exp_hello',
  name: '示例插件',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [
    { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
    { id: 'settings-field', point: 'plan.form-extensions' },
    { id: 'second-action', point: 'cockpit.ui.menubar' },
  ],
  views: {
    'hello-settings': { entry: './views/hello-settings.js' },
    'hello-panel': { entry: './views/hello-panel.js' },
  },
  config: {
    enabled: { type: 'boolean', default: true, label: '开关' },
    retries: { type: 'number', default: 2, label: '重试次数' },
    level: { type: 'string', default: 'info', label: '级别', enum: ['info', 'warn'] },
    'action-label': { type: 'string', default: '示例', label: '按钮文案' },
  },
}

const temporaryDirectories: string[] = []
const generatorTestDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(generatorTestDirectory, '../../../..')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('generatePluginTypes', () => {
  it('与批准的 golden 文件字节一致', () => {
    const generated = generatePluginTypes({ manifest, outDir: './src/generated' })
    const golden = readFileSync(join(generatorTestDirectory, '__fixtures__/plugin-types.golden.txt'), 'utf8')

    expect(generated).toEqual({ fileName: 'plugin-types.ts', source: golden })
    expect(generated.source).not.toContain('\r')
    expect(generated.source.endsWith('\n')).toBe(true)
    expect(generated.source.endsWith('\n\n')).toBe(false)
  })

  it('保持 Extension、Host 首次出现、View 和 Config 的声明顺序', () => {
    const { source } = generatePluginTypes({ manifest, outDir: './src/generated' })

    expect(source.indexOf(`'hello-action'`)).toBeLessThan(source.indexOf(`'settings-field'`))
    expect(source.indexOf('readonly cockpit')).toBeLessThan(source.indexOf('readonly plan'))
    expect(source.indexOf(`'hello-settings'`)).toBeLessThan(source.indexOf(`'hello-panel'`))
    expect(source.indexOf('readonly enabled')).toBeLessThan(source.indexOf('readonly retries'))
    expect(source.indexOf('readonly retries')).toBeLessThan(source.indexOf('readonly level'))
  })

  it('为空 Extension、View 和 Config 生成稳定的空类型', () => {
    const { source } = generatePluginTypes({
      manifest: {
        id: 'exp_example_empty',
        name: '空插件',
        version: '1.0.0',
        entry: './plugin.js',
        extensions: [],
      },
      outDir: './src/generated',
    })

    expect(source).toContain('export type ExtensionId = never')
    expect(source).toContain('export interface ExtensionsByHost {\n}')
    expect(source).toContain('export type ViewId = never')
    expect(source).toContain('export interface PluginConfig {\n}')
    expect(source).not.toContain('export type App')
  })

  it('转义孤立 UTF-16 surrogate，避免 UTF-8 落盘改变生成内容', () => {
    const key = `broken-\uD800`
    const { source } = generatePluginTypes({
      manifest: {
        ...manifest,
        config: {
          [key]: { type: 'string', default: key, label: '异常字符', enum: [key] },
        },
      },
      outDir: './src/generated',
    })

    expect(source).toContain(`'broken-\\ud800'`)
    expect(new TextDecoder().decode(new TextEncoder().encode(source))).toBe(source)
  })

  it('由真实 TypeScript Program 校验 Host、Extension、Point 实现和 Config 类型', () => {
    const generated = generatePluginTypes({ manifest, outDir: './src/generated' })
    const usage = `
import type { AppCockpitContext, AppPlanContext, PluginConfig } from './plugin-types.js'

declare const cockpit: AppCockpitContext
declare const plan: AppPlanContext

void cockpit.extensions.contribute('hello-action', {
  icon: 'hello-icon',
  label: 'Hello',
  onTrigger: () => {},
})
void plan.extensions.contribute('settings-field', {
  render: () => cockpit.views.get('hello-settings'),
  validate: async () => ({ valid: true }),
  onSubmit: async () => ({ hello_flag: true }),
})

const config: PluginConfig = {
  enabled: true,
  retries: 2,
  level: 'info',
  'action-label': 'Hello',
}
void config

// @ts-expect-error 未声明的 Extension ID
void cockpit.extensions.contribute('missing', {})
// @ts-expect-error Cockpit Context 不接受 Plan Extension
void cockpit.extensions.contribute('settings-field', {})
// @ts-expect-error Point implementation 缺少必需的 onTrigger
void cockpit.extensions.contribute('second-action', { icon: 'x', label: 'X' })
// @ts-expect-error Config enum 被精确收窄
const invalidLevel: PluginConfig['level'] = 'error'
void invalidLevel
`

    expect(compileGeneratedTypes(generated.source, usage)).toEqual([])
  })
})

function compileGeneratedTypes (generatedSource: string, usageSource: string): readonly string[] {
  const directory = mkdtempSync(join(tmpdir(), 'fh2-generator-program-'))
  temporaryDirectories.push(directory)
  const generatedFile = join(directory, 'plugin-types.ts')
  const usageFile = join(directory, 'usage.ts')
  writeFileSync(generatedFile, generatedSource, 'utf8')
  writeFileSync(usageFile, usageSource, 'utf8')

  const program = ts.createProgram({
    rootNames: [generatedFile, usageFile],
    options: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: repositoryRoot,
      paths: {
        'fh2-plugin-sdk': ['packages/fh2-plugin-sdk/src/index.ts'],
      },
    },
  })

  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}
