// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { Fh2PluginRawDescriptor, ResolvedPluginEntries } from '../rsbuild/context.js'
import {
  SOURCE_BUILD_RULES,
  buildOutputDirectory,
  sourceDirectoryOf,
  sourceIncludeOf,
} from '../source-build-rules.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { PluginBuildError } from './types.js'
import { BUILD_PHASES } from './policy.js'

// 缺省路径来自结构化规则对象（src/source-build-rules.ts 唯一事实源）。
const DEFAULT_PLUGIN_ENTRY = sourceIncludeOf(SOURCE_BUILD_RULES, 'frontend-plugin-entry')
const DEFAULT_TYPES_OUT_DIR = sourceDirectoryOf(SOURCE_BUILD_RULES, 'frontend-types-generated')
const DEFAULT_DIST_ROOT = buildOutputDirectory(SOURCE_BUILD_RULES, 'frontend', 'frontend-dist')

export interface ResolvedBuildDescriptor {
  readonly manifestPath: string;
  readonly projectRoot: string;
  readonly pluginEntry: string;
  readonly typesOutDir: string;
  readonly distRoot: string;
}

export function resolveBuildDescriptor (
  configCwd: string,
  descriptor: Fh2PluginRawDescriptor,
): ResolvedBuildDescriptor {
  const configuredManifest = resolve(configCwd, descriptor.manifestPath ?? `./${PROJECT_PATHS.sourceManifest}`)
  const manifestPath = requireRegularFile(configuredManifest, 'FH2_MANIFEST_NOT_FOUND', 'config')
  const projectRoot = realpathSync(dirname(manifestPath))
  const pluginEntry = resolveFromRoot(projectRoot, descriptor.pluginEntry ?? `./${DEFAULT_PLUGIN_ENTRY}`)
  const typesOutDir = resolveFromRoot(projectRoot, descriptor.typesOutDir ?? `./${DEFAULT_TYPES_OUT_DIR}`)
  return Object.freeze({
    manifestPath,
    projectRoot,
    pluginEntry,
    typesOutDir,
    distRoot: resolve(projectRoot, DEFAULT_DIST_ROOT),
  })
}

export function resolveSourceEntries (
  descriptor: ResolvedBuildDescriptor,
  manifest: PluginManifest,
): ResolvedPluginEntries {
  const plugin = resolvePluginSourceEntry(descriptor)
  const views: Record<string, string> = {}
  for (const viewId of Object.keys(manifest.views ?? {}))
    views[viewId] = resolveViewSourceEntry(descriptor, viewId)
  return Object.freeze({ plugin, views: Object.freeze(views) })
}

export function resolvePluginSourceEntry (descriptor: ResolvedBuildDescriptor): string {
  return requireContainedFile(
    descriptor.pluginEntry,
    descriptor.projectRoot,
    'FH2_PLUGIN_ENTRY_NOT_FOUND',
    'Plugin Entry',
  )
}

const VIEWS_ROOT = sourceDirectoryOf(SOURCE_BUILD_RULES, 'frontend-views')

export function resolveViewSourceEntry (descriptor: ResolvedBuildDescriptor, viewId: string): string {
  const flat = resolve(descriptor.projectRoot, VIEWS_ROOT, `${viewId}.ts`)
  const nested = resolve(descriptor.projectRoot, VIEWS_ROOT, viewId, 'index.ts')
  const flatExists = isRegularFile(flat)
  const nestedExists = isRegularFile(nested)
  if (flatExists && nestedExists) {
    throw new PluginBuildError([{
      code: 'FH2_VIEW_ENTRY_AMBIGUOUS',
      phase: BUILD_PHASES.resolve,
      file: descriptor.manifestPath,
      message: `View ${viewId} 同时存在 flat 与 nested 源码入口。`,
      hint: `只保留 ${VIEWS_ROOT}/${viewId}.ts 或 ${VIEWS_ROOT}/${viewId}/index.ts 其中一个。`,
    }])
  }
  if (!flatExists && !nestedExists) {
    throw new PluginBuildError([{
      code: 'FH2_VIEW_ENTRY_NOT_FOUND',
      phase: BUILD_PHASES.resolve,
      file: descriptor.manifestPath,
      message: `View ${viewId} 的源码入口不存在。`,
      hint: `创建 ${VIEWS_ROOT}/${viewId}.ts 或 ${VIEWS_ROOT}/${viewId}/index.ts。`,
    }])
  }
  return requireContainedFile(
    flatExists ? flat : nested,
    descriptor.projectRoot,
    'FH2_VIEW_ENTRY_OUTSIDE_PROJECT',
    `View ${viewId} Entry`,
  )
}

export function isPathInside (root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function resolveFromRoot (root: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(root, value)
}

function requireRegularFile (path: string, code: string, phase: 'config' | 'resolve'): string {
  try {
    const realPath = realpathSync(path)
    if (!statSync(realPath).isFile()) throw new Error('不是普通文件')
    return realPath
  } catch (error) {
    throw new PluginBuildError([{
      code,
      phase,
      file: path,
      message: `无法使用文件 ${path}：${error instanceof Error ? error.message : String(error)}`,
    }])
  }
}

function requireContainedFile (path: string, root: string, code: string, label: string): string {
  const realPath = requireRegularFile(path, code, 'resolve')
  if (!isPathInside(root, realPath)) {
    throw new PluginBuildError([{
      code,
      phase: 'resolve',
      file: path,
      message: `${label} 的真实路径必须位于 Manifest 项目根内：${path}`,
    }])
  }
  return realPath
}

function isRegularFile (path: string): boolean {
  if (!existsSync(path)) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
