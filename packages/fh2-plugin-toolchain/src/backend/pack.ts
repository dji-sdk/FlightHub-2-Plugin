// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import type { Buffer } from 'node:buffer'
import {
  copyFileSync,
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
import { PluginPackError } from '../pack/index.js'
import type { PluginPackDiagnostic } from '../pack/index.js'
import { createDeterministicZip } from '../capability/zip.js'
import { SOURCE_BUILD_RULES, buildOutputDirectory } from '../source-build-rules.js'
import { PROJECT_PATHS } from '../project-policy.js'
import { isPackExcluded } from '../capability/policy.js'
import { validateBackendPlugin } from './contract.js'

export interface PackBackendPluginOptions {
  /** 后端插件源码根（dist 位于其内）。 */
  readonly pluginRoot: string;
  /** 输出目录；默认 <pluginRoot>/release。 */
  readonly outputRoot?: string;
}

export interface PackBackendPluginResult {
  readonly releaseRoot: string;
  readonly packageDir: string;
  readonly zipPath: string;
  readonly warnings: readonly PluginPackDiagnostic[];
}

/**
 * 独立后端插件 Pack：把通过 Runtime 契约校验的 dist 组装成
 * release/<pluginId>/ 与 release/<pluginId>.zip。
 * 插件级交付物：不输出 packages.json，不代表完整平台上传单位。
 */
export async function packBackendPlugin (options: PackBackendPluginOptions): Promise<PackBackendPluginResult> {
  const pluginRoot = resolve(options.pluginRoot)
  const distRoot = join(pluginRoot, buildOutputDirectory(SOURCE_BUILD_RULES, 'backend', 'backend-dist'))
  const releaseRoot = resolve(options.outputRoot ?? join(pluginRoot, PROJECT_PATHS.release))

  const validation = validateBackendPlugin(distRoot)
  if (!validation.ok) {
    throw new PluginPackError({
      code: 'FH2_BACKEND_PACK_DIST_INVALID',
      file: join(distRoot, 'plugin.json'),
      message: `后端 dist 未通过 Worker 契约校验，请先 build：\n${validation.diagnostics.map(item => item.message).join('\n')}`,
    })
  }
  const pluginId = validation.manifest.pluginId

  if (isPathInside(realpathSync(distRoot), resolve(releaseRoot))) {
    throw new PluginPackError({
      code: 'FH2_BACKEND_PACK_OUTPUT_UNSAFE',
      file: releaseRoot,
      message: 'Pack 输出目录不能位于 dist 内，避免递归复制运行制品。',
    })
  }

  mkdirSync(releaseRoot, { recursive: true })
  const stagingRoot = join(releaseRoot, `.${pluginId}.fh2-pack-next-${randomUUID()}`)
  const candidateDir = join(stagingRoot, pluginId)
  const candidateZipPath = join(stagingRoot, `${pluginId}.zip`)
  try {
    mkdirSync(candidateDir, { recursive: true })
    copyBackendDistDirectory(distRoot, distRoot, candidateDir)
    writePluginZip(candidateDir, pluginId, candidateZipPath)
    const warnings = commitStagedArtifacts([
      { label: '后端插件包目录', candidatePath: candidateDir, targetPath: join(releaseRoot, pluginId) },
      { label: '后端插件包 zip', candidatePath: candidateZipPath, targetPath: join(releaseRoot, `${pluginId}.zip`) },
    ])
    return {
      releaseRoot,
      packageDir: join(releaseRoot, pluginId),
      zipPath: join(releaseRoot, `${pluginId}.zip`),
      warnings,
    }
  } catch (error) {
    if (error instanceof PluginPackError) throw error
    throw new PluginPackError({
      code: 'FH2_BACKEND_PACK_FAILED',
      file: join(releaseRoot, pluginId),
      message: `生成后端插件交付物失败：${message(error)}`,
    })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

/** 独立前端插件 Pack：dist -> release/<id>/{plugin.json,dist/} + zip。 */
export async function packStandaloneFrontendPlugin (options: {
  readonly projectRoot: string;
  readonly outputRoot?: string;
}): Promise<{
    readonly releaseRoot: string;
    readonly packageDir: string;
    readonly zipPath: string;
    readonly warnings: readonly PluginPackDiagnostic[];
  }> {
  const projectRoot = resolve(options.projectRoot)
  const distRoot = join(projectRoot, buildOutputDirectory(SOURCE_BUILD_RULES, 'frontend', 'frontend-dist'))
  const releaseRoot = resolve(options.outputRoot ?? join(projectRoot, PROJECT_PATHS.release))
  if (!existsSync(join(distRoot, PROJECT_PATHS.sourceManifest))) {
    throw new PluginPackError({
      code: 'FH2_FRONTEND_PACK_DIST_INVALID',
      file: distRoot,
      message: '前端 dist 不存在或不完整，请先 build。',
    })
  }
  mkdirSync(releaseRoot, { recursive: true })
  const stagingRoot = join(releaseRoot, `.frontend-pack-next-${randomUUID()}`)
  try {
    const { packFrontendPlugin } = await import('../pack/index.js')
    const staged = await packFrontendPlugin({ distRoot, outputRoot: stagingRoot })
    const pluginId = staged.packageManifest.pluginId
    const candidateDir = join(stagingRoot, pluginId)
    const candidateZipPath = join(stagingRoot, `${pluginId}.zip`)
    writePluginZip(candidateDir, pluginId, candidateZipPath)
    const warnings = commitStagedArtifacts([
      { label: '前端插件包目录', candidatePath: candidateDir, targetPath: join(releaseRoot, pluginId) },
      { label: '前端插件包 zip', candidatePath: candidateZipPath, targetPath: join(releaseRoot, `${pluginId}.zip`) },
    ])
    return {
      releaseRoot,
      packageDir: join(releaseRoot, pluginId),
      zipPath: join(releaseRoot, `${pluginId}.zip`),
      warnings,
    }
  } catch (error) {
    if (error instanceof PluginPackError) throw error
    throw new PluginPackError({
      code: 'FH2_FRONTEND_PACK_FAILED',
      file: releaseRoot,
      message: `生成前端插件交付物失败：${message(error)}`,
    })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

function copyBackendDistDirectory (root: string, directory: string, outputRoot: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (isPackExcluded(entry.name)) {
      continue
    }
    const source = resolve(directory, entry.name)
    const relativePath = relative(root, source).split(sep).join('/')
    if (entry.isDirectory()) {
      copyBackendDistDirectory(root, source, outputRoot)
      continue
    }
    if (!entry.isFile()) continue
    const realRoot = realpathSync(root)
    const realSource = realpathSync(source)
    if (!isContained(realRoot, realSource)) {
      throw new PluginPackError({
        code: 'FH2_BACKEND_PACK_PATH_UNSAFE',
        file: source,
        message: `后端 dist 资产真实路径越过根目录：${relativePath}。`,
      })
    }
    const target = resolve(outputRoot, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(realSource, target)
  }
}

function writePluginZip (packageDir: string, pluginId: string, zipPath: string): void {
  const entries = collectZipEntries(packageDir, packageDir)
    .map(entry => ({ path: `${pluginId}/${entry.path}`, data: entry.data }))
  writeFileSync(zipPath, createDeterministicZip(entries))
}

function collectZipEntries (root: string, directory: string): Array<{ readonly path: string; readonly data: Buffer }> {
  const entries: Array<{ readonly path: string; readonly data: Buffer }> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (isPackExcluded(entry.name)) {
      continue
    }
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      entries.push(...collectZipEntries(root, path))
      continue
    }
    if (!entry.isFile()) continue
    const relativePath = relative(root, path).split(sep).join('/')
    entries.push({ path: relativePath, data: readFileSync(path) })
  }
  return entries
}

interface PackPromotion {
  readonly label: string;
  readonly candidatePath: string;
  readonly targetPath: string;
}

interface PromotionRecord {
  readonly promotion: PackPromotion;
  readonly backupPath?: string;
}

function commitStagedArtifacts (promotions: readonly PackPromotion[]): readonly PluginPackDiagnostic[] {
  const committed: PromotionRecord[] = []
  try {
    for (const promotion of promotions) {
      const backupPath = join(dirname(promotion.targetPath), `.${basename(promotion.targetPath)}.fh2-pack-backup-${randomUUID()}`)
      const record: PromotionRecord = {
        promotion,
        ...(existsSync(promotion.targetPath) ? { backupPath } : {}),
      }
      if (record.backupPath !== undefined) renameSync(promotion.targetPath, record.backupPath)
      committed.push(record)
      renameSync(promotion.candidatePath, promotion.targetPath)
    }
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const record of [...committed].reverse()) {
      try {
        rmSync(record.promotion.targetPath, { recursive: true, force: true })
        if (record.backupPath !== undefined && existsSync(record.backupPath)) {
          renameSync(record.backupPath, record.promotion.targetPath)
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${record.promotion.label}：${message(rollbackError)}`)
      }
    }
    throw new PluginPackError({
      code: 'FH2_BACKEND_PACK_COMMIT_FAILED',
      message: rollbackErrors.length === 0
        ? `交付物提交失败，已回滚：${message(error)}`
        : `交付物提交失败，回滚不完整：${rollbackErrors.join('；')}`,
    })
  }
  const warnings: PluginPackDiagnostic[] = []
  for (const { backupPath, promotion } of committed) {
    if (backupPath === undefined) continue
    try {
      rmSync(backupPath, { recursive: true, force: true })
    } catch (error) {
      warnings.push({
        code: 'FH2_PACK_BACKUP_CLEANUP_FAILED',
        file: backupPath,
        message: `${promotion.label} 新产物已提交，但旧制品备份清理失败：${message(error)}`,
      })
    }
  }
  return warnings
}

function isPathInside (parent: string, candidate: string): boolean {
  return isContained(parent, candidate) && parent !== candidate
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(realpathSync(root), candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
