// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import Ajv from 'ajv'
import { init, parse } from 'es-module-lexer'
import semver from 'semver'
import { manifestSchema } from 'fh2-plugin-sdk'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { SdkValidationContext } from '../validate/index.js'
import type { BuildProducts } from './products.js'
import { PluginBuildError } from './types.js'

const validateSchema = new Ajv({ allErrors: true }).compile(manifestSchema)
const FORBIDDEN_TRUST_FIELDS = ['trusted', 'trustLevel', 'sandbox'] as const

export interface VerifyDistOptions {
  readonly candidateRoot: string;
  readonly products: BuildProducts;
  readonly sdkContext: SdkValidationContext;
  readonly toolchainVersion: string;
}

export async function verifyDist (options: VerifyDistOptions): Promise<PluginManifest> {
  const manifestPath = resolve(options.candidateRoot, 'fh2-plugin.json')
  const manifest = readDistManifest(manifestPath)
  verifyPortableMetadata(manifest, manifestPath)
  verifyMetadata(manifest, options, manifestPath)
  verifyProductManifest(manifest, options.products, manifestPath)
  await verifyAssetsAndModules(options.candidateRoot, manifest, options.products.assets)
  return manifest
}

/** 复验已构建的可搬运 dist，不依赖本轮 compilation stats。 */
export async function verifyPortableDist (distRoot: string): Promise<PluginManifest> {
  const manifestPath = resolve(distRoot, 'fh2-plugin.json')
  const manifest = readDistManifest(manifestPath)
  verifyPortableMetadata(manifest, manifestPath)
  await verifyAssetsAndModules(distRoot, manifest)
  return manifest
}

function readDistManifest (manifestPath: string): PluginManifest {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw distError('FH2_DIST_MANIFEST_READ_FAILED', `无法读取候选 Dist Manifest：${message(error)}`, manifestPath)
  }
  if (!validateSchema(value)) {
    throw distError(
      'FH2_DIST_MANIFEST_SCHEMA_INVALID',
      `候选 Dist Manifest 未通过 SDK Schema：${new Ajv().errorsText(validateSchema.errors)}`,
      manifestPath,
    )
  }
  return value as unknown as PluginManifest
}

async function verifyAssetsAndModules (
  distRoot: string,
  manifest: PluginManifest,
  compilationAssets: readonly string[] = [],
): Promise<void> {
  const root = realpathSync(distRoot)
  for (const asset of compilationAssets) requireAsset(root, `./${asset}`, 'compilation asset')
  requireAsset(root, manifest.entry, 'Plugin Entry')
  for (const [viewId, view] of Object.entries(manifest.views ?? {})) {
    requireAsset(root, view.entry, `View ${viewId} Entry`)
    for (const style of view.styles ?? []) requireAsset(root, style, `View ${viewId} CSS`)
  }
  for (const icon of manifest.contributes?.icons ?? []) requireAsset(root, icon.src, `Icon ${icon.id}`)

  await init
  await verifyPluginModule(root, manifest.entry)
  for (const view of Object.values(manifest.views ?? {})) await verifyViewModuleClosure(root, view.entry)
}

function verifyPortableMetadata (manifest: PluginManifest, manifestPath: string): void {
  if (!Number.isInteger(manifest.manifestVersion)
    || manifest.engines?.platform === undefined
    || semver.validRange(manifest.engines.platform) === null) {
    throw distError(
      'FH2_DIST_RUNTIME_METADATA_INVALID',
      'Dist Manifest 的 manifestVersion/engines.platform 缺失或不可解析。',
      manifestPath,
    )
  }
  if (manifest.buildInfo === undefined
    || semver.valid(manifest.buildInfo.sdkVersion) === null
    || semver.valid(manifest.buildInfo.toolchainVersion) === null) {
    throw distError(
      'FH2_DIST_BUILD_INFO_INVALID',
      'Dist Manifest buildInfo 缺失或版本不可解析。',
      manifestPath,
    )
  }
  for (const field of FORBIDDEN_TRUST_FIELDS) {
    if (field in manifest)
      throw distError('FH2_DIST_TRUST_FIELD', `Dist Manifest 不得包含 ${field}。`, manifestPath)
  }
}

function verifyMetadata (
  manifest: PluginManifest,
  options: VerifyDistOptions,
  manifestPath: string,
): void {
  const contract = options.sdkContext.runtimeContract
  if (manifest.manifestVersion !== contract.manifestVersion
    || manifest.engines?.platform !== contract.platformRange) {
    throw distError(
      'FH2_DIST_RUNTIME_CONTRACT_MISMATCH',
      'Dist Manifest 的 manifestVersion/engines.platform 与项目 SDK runtime-contract metadata 不一致。',
      manifestPath,
    )
  }
  if (manifest.buildInfo?.sdkVersion !== options.sdkContext.projectSdkVersion
    || manifest.buildInfo?.toolchainVersion !== options.toolchainVersion
    || semver.valid(manifest.buildInfo.sdkVersion) === null
    || semver.valid(manifest.buildInfo.toolchainVersion) === null) {
    throw distError('FH2_DIST_BUILD_INFO_INVALID', 'Dist Manifest buildInfo 缺失、不可解析或与本轮构建上下文不一致。', manifestPath)
  }
}

function verifyProductManifest (
  manifest: PluginManifest,
  products: BuildProducts,
  manifestPath: string,
): void {
  if (manifest.entry !== `./${products.pluginEntryFile}`) {
    throw distError('FH2_DIST_PLUGIN_ENTRY_MISMATCH', 'Dist Manifest Plugin Entry 与 compilation entrypoint 不一致。', manifestPath)
  }
  const views = manifest.views ?? {}
  if (Object.keys(views).length !== products.views.length) {
    throw distError('FH2_DIST_VIEW_COUNT_MISMATCH', 'Dist Manifest View 数量与 compilation entrypoint 数量不一致。', manifestPath)
  }
  for (const product of products.views) {
    const view = views[product.viewId]
    if (view === undefined
      || view.entry !== `./${product.entryFile}`
      || !sameStrings(view.styles ?? [], product.cssFiles.map(file => `./${file}`))) {
      throw distError(
        'FH2_DIST_VIEW_ASSET_MISMATCH',
        `Dist Manifest View ${product.viewId} 的 JS/CSS 与 compilation entrypoint 不一致。`,
        manifestPath,
      )
    }
  }
}

async function verifyPluginModule (root: string, entry: string): Promise<void> {
  const file = resolveAsset(root, entry)
  const source = readFileSync(file, 'utf8')
  const [imports, exports] = parse(source)
  if (imports.length !== 0) {
    throw distError('FH2_DIST_PLUGIN_IMPORT_FORBIDDEN', '最终 Plugin ESM 必须自包含且不能保留 import。', file)
  }
  if (!exports.some(item => (typeof item === 'string' ? item : item.n) === 'default')) {
    throw distError('FH2_DIST_DEFAULT_EXPORT_MISSING', '最终 Plugin ESM 缺少 default export。', file)
  }
}

async function verifyViewModuleClosure (root: string, entry: string): Promise<void> {
  const pending = [resolveAsset(root, entry)]
  const visited = new Set<string>()
  let first = true
  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    const [imports, exports] = parse(source)
    if (first && !exports.some(item => (typeof item === 'string' ? item : item.n) === 'default')) {
      throw distError('FH2_DIST_DEFAULT_EXPORT_MISSING', '最终 View ESM 缺少 default export。', file)
    }
    first = false
    for (const item of imports) {
      if (item.d === -2) continue // import.meta is metadata, not an external module edge.
      if (item.n === undefined || item.n === null) {
        throw distError(
          'FH2_DIST_VIEW_IMPORT_INVALID',
          `View ESM 保留了不可静态解析的 dynamic import：${source.slice(item.ss, item.se)}`,
          file,
        )
      }
      if (!item.n.startsWith('.')) {
        throw distError(
          'FH2_DIST_VIEW_IMPORT_INVALID',
          `View ESM 保留了 bare 或远程 import：${item.n}`,
          file,
        )
      }
      const imported = resolve(dirname(file), item.n)
      requireContainedRegularFile(root, imported, `View ESM import ${item.n}`)
      if (/\.(?:m?js)$/.test(imported)) pending.push(realpathSync(imported))
    }
  }
}

function requireAsset (root: string, manifestPath: string, label: string): string {
  const file = resolveAsset(root, manifestPath)
  requireContainedRegularFile(root, file, label)
  return file
}

function resolveAsset (root: string, manifestPath: string): string {
  const pathname = manifestPath.split(/[?#]/, 1)[0] ?? ''
  if (!manifestPath.startsWith('./')
    || pathname.length <= 2
    || pathname.includes('\\')
    || isAbsolute(pathname)
    || pathname.split('/').includes('..')) {
    throw distError('FH2_DIST_ASSET_PATH_INVALID', `Dist 资源路径不安全：${manifestPath}`)
  }
  return resolve(root, pathname)
}

function requireContainedRegularFile (root: string, file: string, label: string): void {
  let realFile: string
  try {
    realFile = realpathSync(file)
    if (!statSync(realFile).isFile()) throw new Error('不是普通文件')
  } catch (error) {
    throw distError('FH2_DIST_ASSET_MISSING', `${label} 不存在或不是普通文件：${message(error)}`, file)
  }
  const fromRoot = relative(root, realFile)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw distError('FH2_DIST_ASSET_OUTSIDE_ROOT', `${label} 的真实路径越过候选制品根。`, file)
}

function sameStrings (left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function distError (code: string, messageValue: string, file?: string): PluginBuildError {
  return new PluginBuildError([{
    code,
    phase: 'dist',
    ...(file === undefined ? {} : { file }),
    message: messageValue,
  }])
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
