// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { getFh2PluginRawDescriptor } from './context.js'
import { FH2_PLUGIN_DUTIES, fh2Plugin } from './plugin.js'

describe('rsbuild 适配器冒烟', () => {
  it('rsbuild 插件的八条职责登记齐全（toolchain §3）', () => {
    expect(FH2_PLUGIN_DUTIES).toHaveLength(8)
  })

  it('fh2Plugin() 返回合法的 RsbuildPlugin（name + setup）', () => {
    const plugin = fh2Plugin({ manifestPath: '/nonexistent/fh2-plugin.json' })
    expect(plugin.name).toBe('fh2-plugin')
    expect(typeof plugin.setup).toBe('function')
  })

  it('只保存私有 raw descriptor，不在 config 求值时解析 cwd 或读取 Manifest', () => {
    const originalCwd = process.cwd()
    const plugin = fh2Plugin({
      manifestPath: './nested/fh2-plugin.json',
      pluginEntry: './source/main.ts',
      typesOutDir: './types',
    })
    expect(process.cwd()).toBe(originalCwd)
    expect(getFh2PluginRawDescriptor(plugin)).toEqual({
      manifestPath: './nested/fh2-plugin.json',
      pluginEntry: './source/main.ts',
      typesOutDir: './types',
    })
    expect(Object.isFrozen(getFh2PluginRawDescriptor(plugin))).toBe(true)
  })

  it('直接 rsbuild setup 缺少 Runner WeakMap context 时给出明确命令提示', () => {
    const plugin = fh2Plugin()
    expect(() => plugin.setup({} as never)).toThrow('fh2-plugin build')
    expect(() => fh2Plugin({ validateOnBuild: false } as never)).toThrow('始终执行 Validate')
  })
})
