// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { Rspack } from '@rsbuild/core'
import { describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { collectBuildProducts, compileFailureFromStats } from './products.js'
import { PluginBuildError } from './types.js'

const manifest: PluginManifest = {
  id: 'exp_products',
  name: '产物测试',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [],
}

describe('compilation products', () => {
  it('从 compilation 收集绝对 file/missing/context dependencies', () => {
    const products = collectBuildProducts(
      new Map([['plugin', stats(['plugin'], {
        context: ['/project/src/views'],
        file: ['/project/src/plugin.ts', 'relative.ts'],
        missing: ['/project/src/missing.ts'],
      })]]),
      manifest,
      { plugin: '/project/src/plugin.ts', views: {} },
    )
    expect(products.watchDependencies).toEqual([
      '/project/src/missing.ts',
      '/project/src/plugin.ts',
      '/project/src/views',
    ])
  })

  it('拒绝 environment 中未声明的 entrypoint', () => {
    try {
      collectBuildProducts(
        new Map([['plugin', stats(['plugin', 'user-entry'])]]),
        manifest,
        { plugin: '/project/src/plugin.ts', views: {} },
      )
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginBuildError)
      expect((error as PluginBuildError).diagnostics[0]?.code).toBe('FH2_UNEXPECTED_ENTRYPOINT')
    }
  })

  it('拒绝额外 environment stats', () => {
    try {
      collectBuildProducts(
        new Map([
          ['plugin', stats(['plugin'])],
          ['rogue', stats(['rogue'])],
        ]),
        manifest,
        { plugin: '/project/src/plugin.ts', views: {} },
      )
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginBuildError)
      expect((error as PluginBuildError).diagnostics[0]?.code).toBe('FH2_UNEXPECTED_ENVIRONMENT_STATS')
    }
  })

  it('区分带 compilation errors 的普通失败与无 errors 的基础设施崩溃', () => {
    const cleanStats = stats(['plugin'])
    expect(compileFailureFromStats(new Map([['plugin', cleanStats]]), new Error('crash')).diagnostics[0]?.code)
      .toBe('FH2_RSBUILD_INFRASTRUCTURE_FAILED')

    const errorStats = {
      ...stats(['plugin'], { missing: ['/project/outside/missing.ts'] }),
      toJson: () => ({ errors: [{ message: 'syntax error' }] }),
    } as unknown as Rspack.Stats
    const compileFailure = compileFailureFromStats(new Map([['plugin', errorStats]]), new Error('compile'))
    expect(compileFailure.diagnostics[0]?.code).toBe('FH2_RSPACK_COMPILE_ERROR')
    expect(compileFailure.watchDependencies).toEqual(['/project/outside/missing.ts'])
  })
})

function stats (
  entrypoints: readonly string[],
  dependencies: {
    readonly context?: readonly string[];
    readonly file?: readonly string[];
    readonly missing?: readonly string[];
  } = {},
): Rspack.Stats {
  const compilation = {
    assets: { 'plugin.12345678.js': {} },
    contextDependencies: dependencies.context ?? [],
    entrypoints: new Map(entrypoints.map(name => [name, {
      getEntrypointChunk: () => ({ files: ['plugin.12345678.js'] }),
      getFiles: () => ['plugin.12345678.js'],
    }])),
    fileDependencies: dependencies.file ?? [],
    missingDependencies: dependencies.missing ?? [],
    modules: [],
  }
  return {
    compilation,
    hasErrors: () => false,
    toJson: () => ({ errors: [], warnings: [] }),
  } as unknown as Rspack.Stats
}
