// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginManifest, ViewResource } from 'fh2-plugin-sdk'
import { formatValidationIssue, validateSourceManifest } from './validate/index.js'
import { resolveProjectSdkVersion } from './validate/sdk-resolver.js'
import type { SdkRuntimeContract } from './validate/sdk-resolver.js'

export class ManifestError extends Error {
  readonly issues: readonly string[]

  constructor (issues: readonly string[]) {
    super(`Manifest 校验失败：\n${issues.map(issue => `  - ${issue}`).join('\n')}`)
    this.name = 'ManifestError'
    this.issues = issues
  }
}

/** 兼容现有 Build/Rsbuild 调用方的 throwing adapter。 */
export function loadManifest (manifestPath: string): PluginManifest {
  const result = validateSourceManifest({ manifestPath })
  if (!result.ok) throw new ManifestError(result.diagnostics.map(formatValidationIssue))
  return result.manifest
}

/** 解析插件项目实际安装的 SDK 精确版本。 */
export function resolveSdkVersion (fromDir: string): string {
  try {
    return resolveProjectSdkVersion(fromDir)
  } catch (error) {
    throw new ManifestError([error instanceof Error ? error.message : String(error)])
  }
}

export const TOOLCHAIN_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url))
  const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
  return packageJson.version
})()

export interface DistViewAsset {
  readonly viewId: string;
  readonly jsFile: string;
  readonly cssFiles: readonly string[];
}

export interface BuildDistManifestOptions {
  readonly manifest: PluginManifest;
  readonly pluginEntryFile: string;
  readonly viewAssets: readonly DistViewAsset[];
  readonly sdkVersion: string;
  readonly runtimeContract: SdkRuntimeContract;
  readonly toolchainVersion?: string;
}

/** 由 SDK runtime-contract metadata 写入 Dist Manifest；不从 SemVer 推导。 */
export function buildDistManifest (options: BuildDistManifestOptions): PluginManifest {
  const { manifest, pluginEntryFile, viewAssets, sdkVersion, runtimeContract } = options
  const views: Record<string, ViewResource> = {}
  for (const asset of viewAssets) {
    views[asset.viewId] = {
      entry: `./${asset.jsFile}`,
      ...(asset.cssFiles.length > 0 ? { styles: asset.cssFiles.map(file => `./${file}`) } : {}),
    }
  }

  return {
    ...manifest,
    entry: `./${pluginEntryFile}`,
    manifestVersion: runtimeContract.manifestVersion,
    engines: { platform: runtimeContract.platformRange },
    buildInfo: {
      sdkVersion,
      toolchainVersion: options.toolchainVersion ?? TOOLCHAIN_VERSION,
    },
    ...(Object.keys(views).length > 0 ? { views } : {}),
  }
}
