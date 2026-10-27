// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginBuildError } from '../build/types.js'
import {
  PluginPackError,
  discoverIndustryPluginRoots,
  packFrontendPlugin,
  packIndustryPlugins,
  verifyFrontendPluginPackage,
} from './index.js'
import type { FrontendPluginPackageManifest } from './index.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('frontend plugin pack', () => {
  it('完整复制 dist，并生成嵌入完整 Dist Manifest 的 plugin.json', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })

    expect(result.packageRoot).toBe(join(root, 'package/exp_example_pack'))
    expect(existsSync(join(result.packageRoot, 'dist/shared.12345678.js'))).toBe(true)
    expect(existsSync(join(result.packageRoot, 'dist/views/panel.12345678.css'))).toBe(true)
    expect(existsSync(join(result.packageRoot, 'dist/static/icon.svg'))).toBe(true)
    const pluginJson = JSON.parse(readFileSync(result.pluginJsonPath, 'utf8')) as FrontendPluginPackageManifest
    const distManifest = JSON.parse(
      readFileSync(join(result.packageRoot, 'dist/fh2-plugin.json'), 'utf8'),
    ) as PluginManifest
    expect(pluginJson).toEqual({
      pluginId: 'exp_example_pack',
      name: 'Pack 测试插件',
      description: '',
      version: '1.0.0',
      manifest: expect.not.objectContaining({
        id: expect.anything(),
        name: expect.anything(),
        description: expect.anything(),
        version: expect.anything(),
        capabilityId: expect.anything(),
      }),
    })
    expect(pluginJson.manifest).toEqual(expect.objectContaining({
      entry: './dist/plugin.12345678.js',
      extensions: distManifest.extensions,
      manifestVersion: distManifest.manifestVersion,
    }))
    expect(pluginJson.manifest.views?.panel).toEqual({
      entry: './dist/views/panel.12345678.js',
      styles: ['./dist/views/panel.12345678.css'],
    })
    expect(pluginJson.manifest.contributes?.icons?.[0]?.src).toBe('./dist/static/icon.svg')
    await expect(verifyFrontendPluginPackage(result.packageRoot)).resolves.toEqual(pluginJson)
  })

  it('不生成 side，并忽略旧包残留的 side', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })
    const pluginJson = JSON.parse(readFileSync(result.pluginJsonPath, 'utf8')) as Record<string, unknown>
    expect(pluginJson).not.toHaveProperty('side')

    writeFileSync(result.pluginJsonPath, JSON.stringify({ ...pluginJson, side: 'backend' }))
    await expect(verifyFrontendPluginPackage(result.packageRoot)).resolves.toEqual(pluginJson)
  })

  it('重复 pack 原子替换同 ID 的旧包，不保留旧文件', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const outputRoot = join(root, 'package')
    const first = await packFrontendPlugin({ distRoot: dist, outputRoot })
    writeFileSync(join(first.packageRoot, 'stale.txt'), 'old')

    const second = await packFrontendPlugin({ distRoot: dist, outputRoot })
    expect(existsSync(join(second.packageRoot, 'stale.txt'))).toBe(false)
    expect(existsSync(join(second.packageRoot, 'dist/plugin.12345678.js'))).toBe(true)
    expect(readdirSync(outputRoot).some(file => file.includes('.fh2-pack-backup-'))).toBe(false)
  })

  it.each([
    'official_dashboard_ui',
    'exp_customer_plugin',
  ])('接受服务端 Plugin ID %s', async (pluginId) => {
    const root = temporaryRoot()
    const dist = createDist(root, pluginId)
    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })
    expect(result.packageManifest.pluginId).toBe(pluginId)
  })

  it('旧反向域名 ID 在 Pack 复验阶段被拒绝', async () => {
    const root = temporaryRoot()
    const dist = createDist(root, 'com.example.legacy')
    try {
      await packFrontendPlugin({
        distRoot: dist,
        outputRoot: join(root, 'package'),
      })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginBuildError)
      expect((error as PluginBuildError).diagnostics[0]?.code).toBe('FH2_DIST_MANIFEST_SCHEMA_INVALID')
    }
  })

  it('现有 dist 复验失败时保留上一次成功包', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const outputRoot = join(root, 'package')
    const first = await packFrontendPlugin({ distRoot: dist, outputRoot })
    writeFileSync(join(first.packageRoot, 'marker.txt'), 'keep')
    rmSync(join(dist, 'shared.12345678.js'))

    await expect(packFrontendPlugin({
      distRoot: dist,
      outputRoot,
    })).rejects.toBeInstanceOf(PluginBuildError)
    expect(readFileSync(join(first.packageRoot, 'marker.txt'), 'utf8')).toBe('keep')
  })

  it('拒绝输出到 dist 内，并拒绝嵌入 Manifest 被篡改的包', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    await expectPackCode(
      packFrontendPlugin({
        distRoot: dist,
        outputRoot: join(dist, 'package'),
      }),
      'FH2_PACK_OUTPUT_INSIDE_DIST',
    )

    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })
    const pluginJson = JSON.parse(readFileSync(result.pluginJsonPath, 'utf8')) as FrontendPluginPackageManifest
    writeFileSync(result.pluginJsonPath, JSON.stringify({
      ...pluginJson,
      manifest: { ...pluginJson.manifest, version: '9.9.9' },
    }))
    await expectPackCode(
      verifyFrontendPluginPackage(result.packageRoot),
      'FH2_PACK_EMBEDDED_MANIFEST_MISMATCH',
    )
  })

  it('拒绝旧 frontend 包装、未知字段和外层元数据漂移', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })
    const pluginJson = JSON.parse(readFileSync(result.pluginJsonPath, 'utf8')) as FrontendPluginPackageManifest
    writeFileSync(result.pluginJsonPath, JSON.stringify({
      ...pluginJson,
      frontend: { basePath: './dist/', manifest: pluginJson.manifest },
    }))
    await expectPackCode(
      verifyFrontendPluginPackage(result.packageRoot),
      'FH2_PACK_MANIFEST_INVALID',
    )

    writeFileSync(result.pluginJsonPath, JSON.stringify({ ...pluginJson, name: '漂移名称' }))
    await expectPackCode(
      verifyFrontendPluginPackage(result.packageRoot),
      'FH2_PACK_METADATA_MISMATCH',
    )
  })

  it('外层出现已废弃的 capabilityId 字段时被拒绝', async () => {
    const root = temporaryRoot()
    const dist = createDist(root)
    const result = await packFrontendPlugin({
      distRoot: dist,
      outputRoot: join(root, 'package'),
    })
    const pluginJson = JSON.parse(readFileSync(result.pluginJsonPath, 'utf8')) as Record<string, unknown>
    writeFileSync(result.pluginJsonPath, JSON.stringify({
      ...pluginJson,
      capabilityId: 'official_accident',
    }))
    await expectPackCode(
      verifyFrontendPluginPackage(result.packageRoot),
      'FH2_PACK_MANIFEST_INVALID',
    )
  })
})

describe('industry plugin pack', () => {
  it('按目录名扫描 plugins 下的所有插件目录', () => {
    const root = temporaryRoot()
    mkdirSync(join(root, 'plugins/b'), { recursive: true })
    mkdirSync(join(root, 'plugins/a'), { recursive: true })
    writeFileSync(join(root, 'plugins/README.md'), 'ignored')

    expect(discoverIndustryPluginRoots(root)).toEqual([
      join(root, 'plugins/a'),
      join(root, 'plugins/b'),
    ])
  })

  it('拒绝缺失或不包含插件目录的行业包', () => {
    const missing = temporaryRoot()
    expect(() => discoverIndustryPluginRoots(missing)).toThrowError(PluginPackError)

    const empty = temporaryRoot()
    mkdirSync(join(empty, 'plugins'))
    expect(() => discoverIndustryPluginRoots(empty)).toThrowError(PluginPackError)
  })

  it('聚合多个 v3 包到 dist/<pluginId> 并清除旧插件', async () => {
    const root = temporaryRoot()
    const pluginA = join(root, 'plugins/a')
    const pluginB = join(root, 'plugins/b')
    createDist(pluginA, 'official_a')
    createDist(pluginB, 'official_b')
    mkdirSync(join(root, 'dist/official_stale'), { recursive: true })
    writeFileSync(join(root, 'dist/official_stale/old.txt'), 'stale')

    const result = await packIndustryPlugins({
      industryRoot: root,
      pluginRoots: [pluginA, pluginB],
    })

    expect(result.outputRoot).toBe(join(root, 'dist'))
    expect(result.packages.map(item => item.packageManifest.pluginId)).toEqual([
      'official_a',
      'official_b',
    ])
    expect(existsSync(join(root, 'dist/official_a/plugin.json'))).toBe(true)
    expect(existsSync(join(root, 'dist/official_a/dist/fh2-plugin.json'))).toBe(true)
    expect(existsSync(join(root, 'dist/official_b/dist/plugin.12345678.js'))).toBe(true)
    expect(existsSync(join(root, 'dist/official_stale'))).toBe(false)
    const pluginJson = JSON.parse(
      readFileSync(join(root, 'dist/official_a/plugin.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(pluginJson).not.toHaveProperty('capabilityId')
    expect(pluginJson).not.toHaveProperty('side')
    expect(pluginJson.manifest).not.toHaveProperty('id')
    expect(pluginJson.manifest).not.toHaveProperty('name')
    expect(pluginJson.manifest).not.toHaveProperty('version')
    expect(pluginJson.manifest).not.toHaveProperty('description')
    expect(pluginJson.manifest).not.toHaveProperty('capabilityId')
    expect(JSON.parse(
      readFileSync(join(root, 'dist/official_a/dist/fh2-plugin.json'), 'utf8'),
    )).not.toHaveProperty('capabilityId')
  })

  it('拒绝跨目录插件 ID 冲突并保留旧聚合产物', async () => {
    const root = temporaryRoot()
    const pluginA = join(root, 'plugins/a')
    const pluginB = join(root, 'plugins/b')
    createDist(pluginA, 'official_same')
    createDist(pluginB, 'official_same')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist/marker.txt'), 'keep')

    await expectPackCode(
      packIndustryPlugins({ industryRoot: root, pluginRoots: [pluginA, pluginB] }),
      'FH2_PACK_PLUGIN_ID_CONFLICT',
    )
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('keep')
  })

  it('拒绝使用任一插件 dist 作为聚合输出', async () => {
    const root = temporaryRoot()
    const plugin = join(root, 'plugins/a')
    createDist(plugin, 'official_a')

    await expectPackCode(
      packIndustryPlugins({
        industryRoot: root,
        pluginRoots: [plugin],
        outputRoot: join(plugin, 'dist'),
      }),
      'FH2_PACK_OUTPUT_OVERLAPS_SOURCE',
    )
    expect(existsSync(join(plugin, 'dist/fh2-plugin.json'))).toBe(true)
  })

  it('拒绝使用行业包根目录作为聚合输出', async () => {
    const root = temporaryRoot()
    const plugin = join(root, 'plugins/a')
    createDist(plugin, 'official_a')

    await expectPackCode(
      packIndustryPlugins({ industryRoot: root, pluginRoots: [plugin], outputRoot: root }),
      'FH2_PACK_OUTPUT_OVERLAPS_SOURCE',
    )
    expect(existsSync(join(plugin, 'dist/fh2-plugin.json'))).toBe(true)
  })

  it('拒绝通过符号链接把聚合输出指回 plugins 源码目录', async () => {
    const root = temporaryRoot()
    const plugin = join(root, 'plugins/a')
    createDist(plugin, 'official_a')
    symlinkSync(join(root, 'plugins'), join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')

    await expectPackCode(
      packIndustryPlugins({
        industryRoot: root,
        pluginRoots: [plugin],
        outputRoot: join(root, 'redirect/release'),
      }),
      'FH2_PACK_OUTPUT_OVERLAPS_SOURCE',
    )
    expect(existsSync(join(plugin, 'dist/fh2-plugin.json'))).toBe(true)
  })

  it('任一插件 dist 复验失败时保留旧聚合产物', async () => {
    const root = temporaryRoot()
    const plugin = join(root, 'plugins/a')
    createDist(plugin, 'official_a')
    rmSync(join(plugin, 'dist/shared.12345678.js'))
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist/marker.txt'), 'keep')

    await expect(
      packIndustryPlugins({ industryRoot: root, pluginRoots: [plugin] }),
    ).rejects.toBeInstanceOf(PluginBuildError)
    expect(readFileSync(join(root, 'dist/marker.txt'), 'utf8')).toBe('keep')
  })
})

function createDist (
  root: string,
  pluginId = 'exp_example_pack',
): string {
  const dist = join(root, 'dist')
  mkdirSync(join(dist, 'views'), { recursive: true })
  mkdirSync(join(dist, 'static'), { recursive: true })
  writeFileSync(join(dist, 'plugin.12345678.js'), `export default { activate () {} };\n`)
  writeFileSync(
    join(dist, 'views/panel.12345678.js'),
    `import '../shared.12345678.js'; export default function register () {}\n`,
  )
  writeFileSync(join(dist, 'shared.12345678.js'), `export const shared = true;\n`)
  writeFileSync(join(dist, 'views/panel.12345678.css'), '.panel {}\n')
  writeFileSync(join(dist, 'static/icon.svg'), '<svg/>\n')
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: pluginId,
    name: 'Pack 测试插件',
    version: '1.0.0',
    engines: { platform: '>=1.0.0-alpha.0 <2.0.0' },
    entry: './plugin.12345678.js',
    extensions: [],
    views: {
      panel: {
        entry: './views/panel.12345678.js',
        styles: ['./views/panel.12345678.css'],
      },
    },
    contributes: { icons: [{ id: 'icon', src: './static/icon.svg' }] },
    buildInfo: {
      sdkVersion: '1.0.0-alpha.0',
      toolchainVersion: '1.0.0-alpha.0',
    },
  }
  writeFileSync(join(root, 'fh2-plugin.json'), `${JSON.stringify({
    id: pluginId,
    name: manifest.name,
    version: manifest.version,
    entry: './plugin.js',
    extensions: [],
  }, null, 2)}\n`)
  writeFileSync(join(dist, 'fh2-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return dist
}

function temporaryRoot (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-pack-'))
  directories.push(root)
  return root
}

async function expectPackCode (promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPackError)
    expect((error as PluginPackError).diagnostic.code).toBe(code)
  }
}
