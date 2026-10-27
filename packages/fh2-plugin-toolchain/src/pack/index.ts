// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isPluginId } from 'fh2-plugin-sdk'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { PluginBuildError } from '../build/types.js'
import { verifyPortableDist } from '../build/verify.js'

export interface FrontendPluginPackageManifest {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly manifest: FrontendPluginRuntimeManifest;
}

export type FrontendPluginRuntimeManifest = Omit<
  PluginManifest,
  'id' | 'name' | 'description' | 'version'
>

export interface PackFrontendPluginOptions {
  readonly distRoot: string;
  readonly outputRoot: string;
}

export interface PackFrontendPluginResult {
  readonly packageRoot: string;
  readonly pluginJsonPath: string;
  readonly packageManifest: FrontendPluginPackageManifest;
  readonly warnings: readonly PluginPackDiagnostic[];
}

export interface PackIndustryPluginsOptions {
  readonly industryRoot: string;
  readonly pluginRoots: readonly string[];
  readonly outputRoot?: string;
}

export interface PackIndustryPluginsResult {
  readonly outputRoot: string;
  readonly packages: readonly PackFrontendPluginResult[];
  readonly warnings: readonly PluginPackDiagnostic[];
}

export interface PluginPackDiagnostic {
  readonly code: string;
  readonly file?: string;
  readonly message: string;
}

export class PluginPackError extends Error {
  readonly diagnostic: PluginPackDiagnostic

  constructor (diagnostic: PluginPackDiagnostic) {
    super(diagnostic.message)
    this.name = 'PluginPackError'
    this.diagnostic = diagnostic
  }
}

export function discoverIndustryPluginRoots (industryRoot: string): readonly string[] {
  const pluginsRoot = join(resolve(industryRoot), 'plugins')
  let entries
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch (error) {
    throw packError(
      'FH2_PACK_PLUGINS_READ_FAILED',
      `无法读取行业包 plugins 目录：${message(error)}`,
      pluginsRoot,
    )
  }
  const pluginRoots = entries
    .filter(entry => entry.isDirectory())
    .map(entry => join(pluginsRoot, entry.name))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (pluginRoots.length === 0) {
    throw packError(
      'FH2_PACK_PLUGINS_EMPTY',
      '行业包 plugins 目录下没有可打包的插件目录。',
      pluginsRoot,
    )
  }
  return pluginRoots
}

export async function packIndustryPlugins (
  options: PackIndustryPluginsOptions,
): Promise<PackIndustryPluginsResult> {
  const industryRoot = resolve(options.industryRoot)
  const outputRoot = resolve(options.outputRoot ?? join(industryRoot, 'dist'))
  const pluginsRoot = join(industryRoot, 'plugins')
  const canonicalIndustryRoot = canonicalPath(industryRoot)
  const canonicalOutputRoot = canonicalPath(outputRoot)
  const canonicalPluginsRoot = canonicalPath(pluginsRoot)
  if (isPathInside(canonicalOutputRoot, canonicalIndustryRoot)
    || isPathInside(canonicalPluginsRoot, canonicalOutputRoot)) {
    throw packError(
      'FH2_PACK_OUTPUT_OVERLAPS_SOURCE',
      '行业包 Pack 输出目录不能覆盖行业包根目录或位于 plugins 源码目录内。',
      outputRoot,
    )
  }
  for (const pluginRoot of options.pluginRoots) {
    const distRoot = join(resolve(pluginRoot), 'dist')
    if (isPathInside(canonicalPath(distRoot), canonicalOutputRoot)) {
      throw packError(
        'FH2_PACK_OUTPUT_INSIDE_PLUGIN_DIST',
        '行业包 Pack 输出目录不能位于任一插件 dist 内。',
        outputRoot,
      )
    }
  }
  const manifests = await Promise.all(options.pluginRoots.map(async (pluginRootValue) => {
    const pluginRoot = resolve(pluginRootValue)
    return {
      pluginRoot,
      manifest: await verifyPortableDist(join(pluginRoot, 'dist')),
    }
  }))
  const seen = new Map<string, string>()
  for (const { pluginRoot, manifest } of manifests) {
    const previous = seen.get(manifest.id)
    if (previous !== undefined) {
      throw packError(
        'FH2_PACK_PLUGIN_ID_CONFLICT',
        `插件 ID ${manifest.id} 同时来自 ${previous} 与 ${pluginRoot}。`,
        join(pluginRoot, 'dist/fh2-plugin.json'),
      )
    }
    seen.set(manifest.id, pluginRoot)
  }

  mkdirSync(resolve(outputRoot, '..'), { recursive: true })
  const candidateRoot = join(
    resolve(outputRoot, '..'),
    `.${basename(outputRoot)}.fh2-pack-next-${randomUUID()}`,
  )
  let committed = false
  try {
    mkdirSync(candidateRoot)
    const packages: PackFrontendPluginResult[] = []
    for (const pluginRoot of options.pluginRoots) {
      packages.push(await packFrontendPlugin({
        distRoot: join(pluginRoot, 'dist'),
        outputRoot: candidateRoot,
      }))
    }
    const warnings = commitPackageDirectory(candidateRoot, outputRoot)
    committed = true
    return {
      outputRoot,
      packages: packages.map(result => ({
        ...result,
        packageRoot: join(outputRoot, result.packageManifest.pluginId),
        pluginJsonPath: join(outputRoot, result.packageManifest.pluginId, 'plugin.json'),
      })),
      warnings,
    }
  } catch (error) {
    if (error instanceof PluginBuildError || error instanceof PluginPackError) throw error
    throw packError('FH2_PACK_FAILED', `生成行业插件包失败：${message(error)}`, outputRoot)
  } finally {
    if (!committed) rmSync(candidateRoot, { recursive: true, force: true })
  }
}

export async function packFrontendPlugin (
  options: PackFrontendPluginOptions,
): Promise<PackFrontendPluginResult> {
  const distRoot = resolve(options.distRoot)
  const outputRoot = resolve(options.outputRoot)
  if (isPathInside(distRoot, outputRoot)) {
    throw packError(
      'FH2_PACK_OUTPUT_INSIDE_DIST',
      'Pack 输出目录不能位于 dist 内，避免递归复制运行制品。',
      outputRoot,
    )
  }

  const distManifest = await verifyPortableDist(distRoot)
  if (!isPluginId(distManifest.id)) {
    throw packError(
      'FH2_PACK_PLUGIN_ID_INVALID',
      `Plugin ID 必须使用 official_ 或 exp_ 前缀的小写短名：${distManifest.id}`,
      join(distRoot, 'fh2-plugin.json'),
    )
  }
  const packageManifest: FrontendPluginPackageManifest = {
    pluginId: distManifest.id,
    name: distManifest.name,
    description: distManifest.description ?? '',
    version: distManifest.version,
    manifest: toEmbeddedManifest(distManifest),
  }
  mkdirSync(outputRoot, { recursive: true })
  const packageRoot = join(outputRoot, distManifest.id)
  const candidateRoot = join(outputRoot, `.${distManifest.id}.fh2-pack-next-${randomUUID()}`)
  let committed = false
  try {
    mkdirSync(candidateRoot)
    cpSync(distRoot, join(candidateRoot, 'dist'), {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
    const pluginJsonPath = join(candidateRoot, 'plugin.json')
    writeFileSync(pluginJsonPath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')
    await verifyFrontendPluginPackage(candidateRoot, distManifest.id)
    const warnings = commitPackageDirectory(candidateRoot, packageRoot)
    committed = true
    return {
      packageRoot,
      pluginJsonPath: join(packageRoot, 'plugin.json'),
      packageManifest,
      warnings,
    }
  } catch (error) {
    if (error instanceof PluginBuildError || error instanceof PluginPackError) throw error
    throw packError('FH2_PACK_FAILED', `生成前端插件包失败：${message(error)}`, packageRoot)
  } finally {
    if (!committed) rmSync(candidateRoot, { recursive: true, force: true })
  }
}

export async function verifyFrontendPluginPackage (
  packageRoot: string,
  expectedPluginId = basename(resolve(packageRoot)),
): Promise<FrontendPluginPackageManifest> {
  const pluginJsonPath = join(packageRoot, 'plugin.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(pluginJsonPath, 'utf8'))
  } catch (error) {
    throw packError('FH2_PACK_MANIFEST_READ_FAILED', `无法读取 plugin.json：${message(error)}`, pluginJsonPath)
  }
  if (!isPackageManifest(value))
    throw packError('FH2_PACK_MANIFEST_INVALID', 'plugin.json 不符合前端插件包格式。', pluginJsonPath)
  if (!isPluginId(value.pluginId)) {
    throw packError(
      'FH2_PACK_PLUGIN_ID_INVALID',
      `plugin.json.pluginId 必须使用 official_ 或 exp_ 前缀的小写短名：${value.pluginId}`,
      pluginJsonPath,
    )
  }
  if (value.pluginId !== expectedPluginId) {
    throw packError(
      'FH2_PACK_PLUGIN_ID_MISMATCH',
      `plugin.json.pluginId ${value.pluginId} 与目录插件 ID ${expectedPluginId} 不一致。`,
      pluginJsonPath,
    )
  }
  const distManifest = await verifyPortableDist(join(packageRoot, 'dist'))
  if (distManifest.id !== value.pluginId) {
    throw packError(
      'FH2_PACK_PLUGIN_ID_MISMATCH',
      `dist/fh2-plugin.json.id ${distManifest.id} 与 plugin.json.pluginId ${value.pluginId} 不一致。`,
      pluginJsonPath,
    )
  }
  if (value.name !== distManifest.name
    || value.description !== (distManifest.description ?? '')
    || value.version !== distManifest.version) {
    throw packError(
      'FH2_PACK_METADATA_MISMATCH',
      'plugin.json 的 name/description/version 必须与 dist/fh2-plugin.json 一致。',
      pluginJsonPath,
    )
  }
  if (JSON.stringify(toEmbeddedManifest(distManifest)) !== JSON.stringify(value.manifest)) {
    throw packError(
      'FH2_PACK_EMBEDDED_MANIFEST_MISMATCH',
      'plugin.json.manifest 必须与 dist/fh2-plugin.json 去除外层身份字段后的内容完全一致。',
      pluginJsonPath,
    )
  }
  return {
    pluginId: value.pluginId,
    name: value.name,
    description: value.description,
    version: value.version,
    manifest: value.manifest,
  }
}

function toEmbeddedManifest (manifest: PluginManifest): FrontendPluginRuntimeManifest {
  const { id, name, description, version, ...runtimeManifest } = manifest
  void id
  void name
  void description
  void version
  return {
    ...runtimeManifest,
    entry: toPackageResourcePath(runtimeManifest.entry),
    ...(runtimeManifest.views === undefined
      ? {}
      : {
          views: Object.fromEntries(Object.entries(runtimeManifest.views).map(([viewId, view]) => [
            viewId,
            {
              entry: toPackageResourcePath(view.entry),
              ...(view.styles === undefined
                ? {}
                : { styles: view.styles.map(toPackageResourcePath) }),
            },
          ])),
        }),
    ...(runtimeManifest.contributes?.icons === undefined
      ? {}
      : {
          contributes: {
            ...runtimeManifest.contributes,
            icons: runtimeManifest.contributes.icons.map(icon => ({
              ...icon,
              src: toPackageResourcePath(icon.src),
            })),
          },
        }),
  }
}

function toPackageResourcePath (resourcePath: string): string {
  return `./dist/${resourcePath.slice(2)}`
}

function commitPackageDirectory (
  candidateRoot: string,
  packageRoot: string,
): readonly PluginPackDiagnostic[] {
  const backupRoot = join(
    resolve(packageRoot, '..'),
    `.${basename(packageRoot)}.fh2-pack-backup-${randomUUID()}`,
  )
  const hadPackage = existsSync(packageRoot)
  let backedUp = false
  try {
    if (hadPackage) {
      renameSync(packageRoot, backupRoot)
      backedUp = true
    }
    renameSync(candidateRoot, packageRoot)
  } catch (error) {
    if (backedUp) {
      try {
        renameSync(backupRoot, packageRoot)
      } catch (rollbackError) {
        throw packError(
          'FH2_PACK_COMMIT_ROLLBACK_FAILED',
          `提交 package 失败且旧包回滚失败：${message(error)}；回滚错误：${message(rollbackError)}`,
          packageRoot,
        )
      }
    }
    throw packError(
      'FH2_PACK_COMMIT_FAILED',
      `提交 package 失败，旧包已保留：${message(error)}`,
      packageRoot,
    )
  }
  if (!backedUp) return []
  try {
    rmSync(backupRoot, { recursive: true, force: true })
    return []
  } catch (error) {
    return [{
      code: 'FH2_PACK_BACKUP_CLEANUP_FAILED',
      file: backupRoot,
      message: `新 package 已提交，但旧包备份清理失败：${message(error)}`,
    }]
  }
}

function isPackageManifest (value: unknown): value is FrontendPluginPackageManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const allowed = new Set([
    'pluginId',
    'name',
    'description',
    'version',
    'side',
    'manifest',
  ])
  return Object.keys(record).every(key => allowed.has(key))
    && typeof record.pluginId === 'string'
    && typeof record.name === 'string'
    && typeof record.description === 'string'
    && typeof record.version === 'string'
    && typeof record.manifest === 'object'
    && record.manifest !== null
    && !Array.isArray(record.manifest)
}

function isPathInside (root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function canonicalPath (pathValue: string): string {
  let existing = resolve(pathValue)
  const missingSegments: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missingSegments.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...missingSegments)
}

function packError (code: string, messageValue: string, file?: string): PluginPackError {
  return new PluginPackError({
    code,
    ...(file === undefined ? {} : { file }),
    message: messageValue,
  })
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
