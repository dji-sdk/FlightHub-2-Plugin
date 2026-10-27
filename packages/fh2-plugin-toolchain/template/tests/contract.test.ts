// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadManifest } from 'fh2-plugin-toolchain'

const manifest = loadManifest(resolve('fh2-plugin.json'))

describe('插件契约', () => {
  it('manifest 声明的 View 与 src/views 目录一一对应', () => {
    const viewDirectories = readdirSync(resolve('src/views'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(Object.keys(manifest.views ?? {}).sort()).toEqual(viewDirectories)
  })

  it('扩展点、权限与图标声明保持一致', () => {
    const extensionPoints = new Set(manifest.extensions.map(extension => extension.point))
    expect(extensionPoints.has('cockpit.ui.toolbar-actions')).toBe(true)

    if (manifest.extensions.some(extension => extension.id === 'hello-panel')) {
      expect(extensionPoints.has('cockpit.ui.left-panel')).toBe(true)
    }
    if (manifest.extensions.some(extension => extension.id === 'issue-panel')) {
      expect(extensionPoints.has('cockpit.ui.left-bottom-panels')).toBe(true)
      expect(manifest.permissions ?? []).toContain('platform:dialog')
    }
    const expectedIcons = [
      ...(manifest.extensions.some(extension => extension.id === 'hello-panel') ? ['plugin'] : []),
      ...(manifest.extensions.some(extension => extension.id === 'issue-panel') ? ['issue', 'issue-active'] : []),
    ]
    expect((manifest.contributes?.icons ?? []).map(icon => icon.id)).toEqual(expectedIcons)
    for (const icon of manifest.contributes?.icons ?? [])
      expect(existsSync(resolve('public', icon.src))).toBe(true)

    expect(manifest).not.toHaveProperty('manifestVersion')
    expect(manifest).not.toHaveProperty('engines')
    expect(manifest).not.toHaveProperty('buildInfo')
  })
})
