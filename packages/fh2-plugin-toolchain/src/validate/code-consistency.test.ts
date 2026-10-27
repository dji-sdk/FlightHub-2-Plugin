// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { resolveBuildDescriptor } from '../build/paths.js'
import {
  checkSourceCodeConsistency,
  isBlockingCodeConsistencyDiagnostic,
} from './code-consistency.js'

const MANIFEST: PluginManifest = {
  id: 'exp_demo',
  name: '一致性校验插件',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [{ id: 'hello-action', point: 'cockpit.ui.toolbar-actions' }],
  views: { 'hello-panel': { entry: './views/hello-panel.js' } },
  config: { welcomeText: { type: 'string', default: 'Hi', label: '欢迎语' } },
}

const PLUGIN_TS = `import { definePlugin } from 'fh2-plugin-sdk'

export default definePlugin({
  activate: async (ctx) => {
    const { activate } = await import('./hosts/cockpit/activate')
    await activate(ctx)
  },
})
`

const ACTIVATE_TS = `import type { AppCockpitContext } from '../../generated/plugin-types'

export async function activate (ctx: AppCockpitContext) {
  await ctx.extensions.contribute('hello-action', {
    icon: 'plugin',
    label: '示例',
    onTrigger: () => {},
  })
  void ctx.config.welcomeText
}
`

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function createProject (options: {
  readonly manifest?: PluginManifest;
  readonly plugin?: string;
  readonly activate?: string;
  readonly mutate?: (project: string) => void;
} = {}): {
    readonly project: string;
    readonly manifest: PluginManifest;
    readonly manifestPath: string;
  } {
  const project = mkdtempSync(join(tmpdir(), 'fh2-code-consistency-'))
  const manifest = options.manifest ?? MANIFEST
  temporaryDirectories.push(project)
  mkdirSync(join(project, 'src/hosts/cockpit'), { recursive: true })
  mkdirSync(join(project, 'src/views/hello-panel'), { recursive: true })
  writeFileSync(join(project, 'fh2-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(project, 'package.json'), `{ "name": "demo-plugin", "private": true }\n`)
  writeFileSync(join(project, 'src/plugin.ts'), options.plugin ?? PLUGIN_TS)
  writeFileSync(join(project, 'src/hosts/cockpit/activate.ts'), options.activate ?? ACTIVATE_TS)
  writeFileSync(join(project, 'src/views/hello-panel/index.ts'), `export { mount } from './mount.ts'\n`)
  writeFileSync(join(project, 'src/views/hello-panel/mount.ts'), `export function mount () {}\n`)
  options.mutate?.(project)
  return { project, manifest, manifestPath: join(project, 'fh2-plugin.json') }
}

function diagnostics (project: ReturnType<typeof createProject>) {
  return checkSourceCodeConsistency({ manifest: project.manifest, manifestPath: project.manifestPath })
}

function codes (project: ReturnType<typeof createProject>): readonly string[] {
  return diagnostics(project).map(diagnostic => diagnostic.code)
}

describe('checkSourceCodeConsistency', () => {
  it('当前模板契约扫描结果为空', () => {
    expect(diagnostics(createProject())).toEqual([])
  })

  it('手写 Extension 到 Point 映射或未消费生成类型时是阻断错误', () => {
    const handwritten = createProject({
      activate: `import type { PluginContext } from 'fh2-plugin-sdk'
export async function activate (ctx: PluginContext<Record<string, never>, {
  'hello-action': 'cockpit.ui.toolbar-actions';
}>) {
  await ctx.extensions.contribute('hello-action', { icon: 'plugin', label: '示例', onTrigger: () => {} })
}
`,
    })
    const handwrittenDiagnostics = diagnostics(handwritten)
    expect(handwrittenDiagnostics.map(diagnostic => diagnostic.code)).toContain('FH2_CODE_CONTEXT_HANDWRITTEN')
    expect(handwrittenDiagnostics.filter(isBlockingCodeConsistencyDiagnostic).map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'FH2_CODE_CONTEXT_HANDWRITTEN',
      'FH2_CODE_GENERATED_TYPES_UNUSED',
    ]))

    const unused = createProject({ activate: `export async function activate () {}
` })
    expect(diagnostics(unused).map(diagnostic => diagnostic.code)).toContain('FH2_CODE_GENERATED_TYPES_UNUSED')
  })

  it('c-01 Entry 缺失或没有 definePlugin 默认导出', () => {
    const missing = createProject({ mutate: project => rmSync(join(project, 'src/plugin.ts')) })
    expect(codes(missing)).toContain('FH2_CODE_ENTRY_DEFINE_PLUGIN')

    const noDefine = createProject({ plugin: `export default {}\n` })
    expect(codes(noDefine)).toContain('FH2_CODE_ENTRY_DEFINE_PLUGIN')

    const unrelatedDefine = createProject({
      plugin: `const other = definePlugin({ activate: async () => {} })\nexport default {}\nvoid other\n`,
    })
    expect(codes(unrelatedDefine)).toContain('FH2_CODE_ENTRY_DEFINE_PLUGIN')

    const variableExport = createProject({
      plugin: `const plugin = definePlugin({ activate: async () => {} })\nexport default plugin\n`,
    })
    expect(codes(variableExport)).not.toContain('FH2_CODE_ENTRY_DEFINE_PLUGIN')
  })

  it('c-02 Manifest extension 未在源码中 contribute', () => {
    const project = createProject({ activate: `export async function activate () {}\n` })
    expect(codes(project)).toContain('FH2_CODE_EXTENSION_NOT_CONTRIBUTED')
  })

  it('c-03 View 同时支持 flat/nested，并报告缺失和歧义', () => {
    const flat = createProject({
      mutate: (project) => {
        rmSync(join(project, 'src/views/hello-panel'), { recursive: true })
        writeFileSync(join(project, 'src/views/hello-panel.ts'), `export function mount () {}\n`)
      },
    })
    expect(codes(flat)).not.toContain('FH2_CODE_VIEW_SOURCE_MISSING')

    const missing = createProject({
      mutate: project => rmSync(join(project, 'src/views/hello-panel'), { recursive: true }),
    })
    expect(codes(missing)).toContain('FH2_CODE_VIEW_SOURCE_MISSING')

    const ambiguous = createProject({
      mutate: project => writeFileSync(join(project, 'src/views/hello-panel.ts'), `export function mount () {}\n`),
    })
    expect(codes(ambiguous)).toContain('FH2_CODE_VIEW_SOURCE_AMBIGUOUS')
  })

  it('自定义 pluginEntry 复用 Build descriptor', () => {
    const project = createProject({
      mutate: (root) => {
        mkdirSync(join(root, 'custom'), { recursive: true })
        writeFileSync(join(root, 'custom/entry.ts'), PLUGIN_TS)
        rmSync(join(root, 'src/plugin.ts'))
      },
    })
    const descriptor = resolveBuildDescriptor(project.project, {
      manifestPath: project.manifestPath,
      pluginEntry: './custom/entry.ts',
    })
    expect(checkSourceCodeConsistency({
      manifest: project.manifest,
      manifestPath: project.manifestPath,
      descriptor,
    }).map(diagnostic => diagnostic.code)).not.toContain('FH2_CODE_ENTRY_DEFINE_PLUGIN')
  })

  it('extension、View、Config 分命名空间检查未声明引用', () => {
    const project = createProject({
      activate: `export async function activate (ctx: AppCockpitContext) {
  await ctx.extensions.contribute('ghost-action', {})
  void ctx.views.get('ghost-view')
  const { config: pluginConfig } = ctx
  void pluginConfig['ghost-config']
}
`,
    })
    const messages = diagnostics(project)
      .filter(diagnostic => diagnostic.code === 'FH2_CODE_REFERENCE_NOT_DECLARED')
      .map(diagnostic => diagnostic.message)
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('extension ID "ghost-action"'),
      expect.stringContaining('view ID "ghost-view"'),
      expect.stringContaining('config key "ghost-config"'),
    ]))
  })

  it('capability 检查 Catalog、顶层 facade 和 Manifest permission', () => {
    const manifest: PluginManifest = { ...MANIFEST, permissions: ['cockpit:telemetry', 'project:context'] }
    const project = createProject({
      manifest,
      activate: `${ACTIVATE_TS}
export async function capabilities (ctx: AppCockpitContext, dynamicId: string) {
  await ctx.capabilities.get('cockpit:telemetry')
  await ctx.capabilities.get('cockpit:camera')
  await ctx.capabilities.get('platform:http')
  await ctx.capabilities.get('cockpit:map')
  await ctx.capabilities.get('project:context')
  await ctx.capabilities.get(dynamicId)
}
`,
    })
    const found = codes(project)
    expect(found).toContain('FH2_CODE_CAPABILITY_PERMISSION_MISSING')
    expect(found).toContain('FH2_CODE_CAPABILITY_NOT_PLUGIN_ACCESSIBLE')
    expect(found).toContain('FH2_CODE_CAPABILITY_NOT_IN_CATALOG')
    expect(found).toContain('FH2_CODE_CAPABILITY_HOST_MISMATCH')
    expect(found.filter(code => code.startsWith('FH2_CODE_CAPABILITY_'))).toHaveLength(4)
  })

  it('view TypeScript 中的 Capability 字面量也参与 permission 检查', () => {
    const project = createProject({
      mutate: root => writeFileSync(
        join(root, 'src/views/hello-panel/mount.ts'),
        `export async function mount (ctx: any) { await ctx.capabilities.get('cockpit:camera') }\n`,
      ),
    })
    expect(codes(project)).toContain('FH2_CODE_CAPABILITY_PERMISSION_MISSING')
  })

  it('entry 直接 import Vue 或访问 DOM', () => {
    const project = createProject({
      plugin: `import { definePlugin } from 'fh2-plugin-sdk'
import { createApp } from 'vue'
export default definePlugin({ activate: async () => { void createApp; void document.body } })
`,
    })
    expect(codes(project).filter(code => code === 'FH2_CODE_ENTRY_VUE_OR_DOM')).toHaveLength(2)
  })

  it('manifest id 与 package.json name 不一致', () => {
    const project = createProject({
      mutate: root => writeFileSync(join(root, 'package.json'), `{ "name": "unrelated-name", "private": true }\n`),
    })
    expect(codes(project)).toContain('FH2_CODE_PACKAGE_NAME_MISMATCH')
  })

  it('warning 均为 code phase、中英双语且稳定排序', () => {
    const project = createProject({
      mutate: (root) => {
        rmSync(join(root, 'src/plugin.ts'))
        rmSync(join(root, 'src/views/hello-panel'), { recursive: true })
      },
      activate: `export async function activate (ctx: AppCockpitContext) {
  await ctx.extensions.contribute('ghost-action', {})
}
`,
    })
    const first = diagnostics(project)
    const second = diagnostics(project)
    expect(first.length).toBeGreaterThan(1)
    for (const warning of first) {
      expect(warning.phase).toBe('code')
      expect(warning.code.startsWith('FH2_CODE_')).toBe(true)
      expect(warning.message).toContain('。')
      expect(warning.message).toMatch(/[A-Za-z]{4,}/)
    }
    expect(first).toEqual(second)
  })
})
