// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ManifestError, buildDistManifest, loadManifest } from './manifest.js'
import { resolveProjectSdkContext } from './validate/sdk-resolver.js'

const fixtureRoot = fileURLToPath(new URL('./__fixtures__/valid-source/', import.meta.url))

describe('loadManifest throwing adapter', () => {
  it('返回通过公共 Validator 的 Source Manifest fixture', () => {
    expect(loadManifest(resolve(fixtureRoot, 'fh2-plugin.json'))).toMatchObject({
      id: 'exp_manifest_fixture',
      entry: './plugin.js',
      permissions: ['platform:dialog'],
      extensions: [{ id: 'fixture-action', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' }],
    })
  })

  it('把结构化 diagnostics 转成 ManifestError.issues', () => {
    expect(() => loadManifest('/nonexistent/fh2-plugin.json')).toThrow(ManifestError)
    try {
      loadManifest('/nonexistent/fh2-plugin.json')
    } catch (error) {
      expect((error as ManifestError).issues[0]).toContain('FH2_MANIFEST_READ_FAILED')
    }
  })
})

describe('buildDistManifest runtime contract metadata', () => {
  it('原样复制 SDK runtime-contract，不从 SDK SemVer 推导', () => {
    const source = loadManifest(resolve(fixtureRoot, 'fh2-plugin.json'))
    const sdkContext = resolveProjectSdkContext(fixtureRoot)
    const dist = buildDistManifest({
      manifest: source,
      pluginEntryFile: 'plugin.hash.js',
      viewAssets: [{ viewId: 'issue-panel', jsFile: 'views/issue-panel.hash.js', cssFiles: [] }],
      sdkVersion: sdkContext.projectSdkVersion,
      runtimeContract: sdkContext.runtimeContract,
    })

    expect(dist.manifestVersion).toBe(sdkContext.runtimeContract.manifestVersion)
    expect(dist.engines?.platform).toBe(sdkContext.runtimeContract.platformRange)
    expect(dist.buildInfo?.sdkVersion).toBe(sdkContext.projectSdkVersion)
    expect(dist).not.toHaveProperty('capabilityId')
  })

  it('只使用调用方携带的项目 SDK metadata，不回退到 Toolchain import', () => {
    const source = loadManifest(resolve(fixtureRoot, 'fh2-plugin.json'))
    const dist = buildDistManifest({
      manifest: source,
      pluginEntryFile: 'plugin.hash.js',
      viewAssets: [],
      sdkVersion: '9.8.7',
      runtimeContract: {
        schemaVersion: 1,
        manifestVersion: 9,
        platformVersion: '9.0.0',
        platformRange: '>=9.0.0 <10.0.0',
      },
    })
    expect(dist).toMatchObject({
      manifestVersion: 9,
      engines: { platform: '>=9.0.0 <10.0.0' },
      buildInfo: { sdkVersion: '9.8.7' },
    })
  })
})
