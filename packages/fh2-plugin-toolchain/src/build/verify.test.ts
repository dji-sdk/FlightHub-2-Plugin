// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { BuildProducts } from './products.js'
import { PluginBuildError } from './types.js'
import { verifyDist } from './verify.js'

const directories: string[] = []
const sdkContext = {
  projectSdkVersion: '1.0.0-alpha.0',
  toolchainSdkVersion: '1.0.0-alpha.0',
  runtimeContract: {
    schemaVersion: 1 as const,
    manifestVersion: 1,
    platformVersion: '1.0.0',
    platformRange: '>=1.0.0-alpha.0 <2.0.0',
  },
}
const products: BuildProducts = {
  pluginEntryFile: 'plugin.12345678.js',
  views: [{ viewId: 'panel', entryFile: 'views/panel.12345678.js', cssFiles: ['views/panel.12345678.css'] }],
  assets: [
    'plugin.12345678.js',
    'views/panel.12345678.js',
    'views/panel.12345678.css',
    'views/shared.12345678.js',
    'icons/icon.svg',
  ],
  watchDependencies: [],
  warnings: [],
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('候选 Dist 磁盘复验', () => {
  it('不执行代码即可校验 Schema、metadata、文件、相对 ESM closure 与 default export', async () => {
    const root = fixture()
    await expect(verifyDist({
      candidateRoot: root,
      products,
      sdkContext,
      toolchainVersion: '1.0.0-alpha.0',
    })).resolves.toMatchObject({ id: 'exp_verify', manifestVersion: 1 })
  })

  it.each([
    ['runtime metadata', (manifest: PluginManifest) => ({ ...manifest, manifestVersion: 2 }), 'FH2_DIST_RUNTIME_CONTRACT_MISMATCH'],
    ['entrypoint', (manifest: PluginManifest) => ({ ...manifest, entry: './plugin.other.js' }), 'FH2_DIST_PLUGIN_ENTRY_MISMATCH'],
  ] as const)('拒绝不一致的 %s', async (_name, mutate, code) => {
    const root = fixture(mutate)
    await expectCode(verifyDist({
      candidateRoot: root,
      products,
      sdkContext,
      toolchainVersion: '1.0.0-alpha.0',
    }), code)
  })

  it('拒绝 View bare/computed import 和丢失的 compilation asset', async () => {
    const bare = fixture()
    writeFileSync(join(bare, 'views/panel.12345678.js'), `import 'vue'; export default {};\n`)
    await expectCode(verifyDist({
      candidateRoot: bare,
      products,
      sdkContext,
      toolchainVersion: '1.0.0-alpha.0',
    }), 'FH2_DIST_VIEW_IMPORT_INVALID')

    const computed = fixture()
    writeFileSync(
      join(computed, 'views/panel.12345678.js'),
      `const name = 'shared.12345678.js'; void import('.' + name); export default {};\n`,
    )
    await expectCode(verifyDist({
      candidateRoot: computed,
      products,
      sdkContext,
      toolchainVersion: '1.0.0-alpha.0',
    }), 'FH2_DIST_VIEW_IMPORT_INVALID')

    const missing = fixture()
    rmSync(join(missing, 'views/shared.12345678.js'))
    await expectCode(verifyDist({
      candidateRoot: missing,
      products,
      sdkContext,
      toolchainVersion: '1.0.0-alpha.0',
    }), 'FH2_DIST_ASSET_MISSING')
  })
})

function fixture (mutate: (manifest: PluginManifest) => PluginManifest = value => value): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-build-verify-'))
  directories.push(root)
  mkdirSync(join(root, 'views'), { recursive: true })
  mkdirSync(join(root, 'icons'), { recursive: true })
  writeFileSync(join(root, 'plugin.12345678.js'), `throw new Error('must not execute'); export default {};\n`)
  writeFileSync(join(root, 'views/panel.12345678.js'), `import './shared.12345678.js'; export default {};\n`)
  writeFileSync(join(root, 'views/shared.12345678.js'), `export const shared = true;\n`)
  writeFileSync(join(root, 'views/panel.12345678.css'), '.panel {}\n')
  writeFileSync(join(root, 'icons/icon.svg'), '<svg/>\n')
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: 'exp_verify',
    name: '复验插件',
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
    contributes: { icons: [{ id: 'icon', src: './icons/icon.svg' }] },
    buildInfo: { sdkVersion: '1.0.0-alpha.0', toolchainVersion: '1.0.0-alpha.0' },
  }
  writeFileSync(join(root, 'fh2-plugin.json'), `${JSON.stringify(mutate(manifest), null, 2)}\n`)
  return root
}

async function expectCode (promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(PluginBuildError)
    expect((error as PluginBuildError).diagnostics[0]?.code).toBe(code)
  }
}
