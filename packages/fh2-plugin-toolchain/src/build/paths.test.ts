// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginBuildError } from './types.js'
import { resolveBuildDescriptor, resolveSourceEntries } from './paths.js'

const directories: string[] = []
const manifest: PluginManifest = {
  id: 'exp_paths',
  name: '路径测试',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [],
  views: { panel: { entry: './views/panel.js' } },
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('build descriptor 与源码入口解析', () => {
  it('manifest 相对 config cwd，其他路径相对 Manifest 项目根解析', () => {
    const root = project()
    mkdirSync(join(root, 'plugin/src/views'), { recursive: true })
    writeFileSync(join(root, 'plugin/fh2-plugin.json'), '{}')
    writeFileSync(join(root, 'plugin/src/main.ts'), '')
    writeFileSync(join(root, 'plugin/src/views/panel.ts'), '')
    const descriptor = resolveBuildDescriptor(root, {
      manifestPath: './plugin/fh2-plugin.json',
      pluginEntry: './src/main.ts',
      typesOutDir: './generated',
    })
    const entries = resolveSourceEntries(descriptor, manifest)
    const realRoot = realpathSync(root)
    expect(entries.plugin).toBe(join(realRoot, 'plugin/src/main.ts'))
    expect(entries.views.panel).toBe(join(realRoot, 'plugin/src/views/panel.ts'))
    expect(descriptor.typesOutDir).toBe(join(realRoot, 'plugin/generated'))
  })

  it('支持 nested View，缺失和 flat/nested 歧义使用稳定诊断码', () => {
    const root = projectWithPlugin()
    const descriptor = resolveBuildDescriptor(root, {})
    mkdirSync(join(root, 'src/views/panel'), { recursive: true })
    writeFileSync(join(root, 'src/views/panel/index.ts'), '')
    expect(resolveSourceEntries(descriptor, manifest).views.panel).toBe(join(realpathSync(root), 'src/views/panel/index.ts'))

    writeFileSync(join(root, 'src/views/panel.ts'), '')
    expectCode(() => resolveSourceEntries(descriptor, manifest), 'FH2_VIEW_ENTRY_AMBIGUOUS')
    rmSync(join(root, 'src/views/panel.ts'))
    rmSync(join(root, 'src/views/panel'), { recursive: true })
    expectCode(() => resolveSourceEntries(descriptor, manifest), 'FH2_VIEW_ENTRY_NOT_FOUND')
  })

  // Windows 文件 symlink 需要开发者模式/管理员（EPERM）；junction 仅支持目录。
  // 该逃逸场景由 macOS/Linux CI 覆盖，Windows 上跳过。
  it.skipIf(process.platform === 'win32')('拒绝 Plugin/View symlink 逃逸项目根', () => {
    const root = projectWithPlugin()
    const outside = project()
    writeFileSync(join(outside, 'outside.ts'), '')
    rmSync(join(root, 'src/plugin.ts'))
    symlinkSync(join(outside, 'outside.ts'), join(root, 'src/plugin.ts'))
    const { views: _views, ...manifestWithoutViews } = manifest
    expectCode(
      () => resolveSourceEntries(resolveBuildDescriptor(root, {}), manifestWithoutViews),
      'FH2_PLUGIN_ENTRY_NOT_FOUND',
    )
  })
})

function project (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-build-paths-'))
  directories.push(root)
  return root
}

function projectWithPlugin (): string {
  const root = project()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'fh2-plugin.json'), '{}')
  writeFileSync(join(root, 'src/plugin.ts'), '')
  return root
}

function expectCode (operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(PluginBuildError)
    expect((error as PluginBuildError).diagnostics[0]?.code).toBe(code)
  }
}
