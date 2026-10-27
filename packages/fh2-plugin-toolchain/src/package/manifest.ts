// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseStrictJson } from '../validate/json-reader.js'
import { PACKAGE_MANIFEST_FILE, PackageError, packageManifestPath } from './types.js'
import type { PackageManifestEntry } from './types.js'

/** 当前阶段一个 Workspace 只允许描述一个上传包。 */
const MAX_PACKAGE_ENTRIES = 1

/** 读取并校验 Capability 或行业 Capability 工作区根的 packages.json。 */
export function readPackageManifest (root: string): PackageManifestEntry {
  const file = packageManifestPath(root)
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    throw new PackageError(
      'FH2_PACKAGE_MANIFEST_NOT_FOUND',
      `无法读取 ${file}：${message(error)}`,
      file,
    )
  }
  return parsePackageManifest(source, file)
}

export function parsePackageManifest (source: string, file: string): PackageManifestEntry {
  const parsed = parseStrictJson(source, file)
  if (!parsed.ok) {
    throw new PackageError(
      'FH2_PACKAGE_MANIFEST_INVALID',
      `${PACKAGE_MANIFEST_FILE} 不是合法 JSON：${parsed.diagnostics.map(item => item.message).join(' ')}`,
      file,
    )
  }
  const value = parsed.parsed.value
  if (!Array.isArray(value)) {
    throw new PackageError('FH2_PACKAGE_MANIFEST_INVALID', `${file} 必须是 JSON 数组。`, file)
  }
  if (value.length === 0) {
    throw new PackageError('FH2_PACKAGE_MANIFEST_INVALID', `${file} 不能是空数组。`, file)
  }
  if (value.length > MAX_PACKAGE_ENTRIES) {
    throw new PackageError(
      'FH2_PACKAGE_MANIFEST_INVALID',
      `${file} 当前只允许一个包条目，实际 ${value.length} 个。`,
      file,
    )
  }
  const entry = value[0]
  if (!isRecord(entry)) {
    throw new PackageError('FH2_PACKAGE_MANIFEST_INVALID', `${file} 的包条目必须是 JSON 对象。`, file)
  }
  const unknown = Object.keys(entry).filter(key => key !== 'packageId' && key !== 'name' && key !== 'capabilityIds')
  if (unknown.length > 0) {
    throw new PackageError(
      'FH2_PACKAGE_MANIFEST_INVALID',
      `${file} 包含未知字段：${unknown.join(', ')}。`,
      file,
    )
  }
  const packageId = assertNonEmptyString(entry.packageId, 'packageId', file)
  const name = assertNonEmptyString(entry.name, 'name', file)
  const capabilityIds = assertCapabilityIds(entry.capabilityIds, file)
  return Object.freeze({ packageId, name, capabilityIds })
}

/** 规范化输出：字段顺序固定、2 空格缩进、结尾换行。 */
export function serializePackageManifest (entry: PackageManifestEntry): string {
  return `${JSON.stringify([{
    packageId: entry.packageId,
    name: entry.name,
    capabilityIds: [...entry.capabilityIds],
  }], null, 2)}\n`
}

/** 校验 packages.json 描述的 capabilityIds 与 Capability 根目录一致。 */
export function assertPackageMatchesCapability (
  entry: PackageManifestEntry,
  capabilityId: string,
  file: string,
): void {
  const expected = [capabilityId]
  const actual = [...entry.capabilityIds]
  if (actual.length === expected.length && actual.every((id, index) => id === expected[index])) return
  throw new PackageError(
    'FH2_PACKAGE_CAPABILITY_MISMATCH',
    `${file} 的 capabilityIds [${actual.join(', ')}] 必须且只能包含当前 Capability：${capabilityId}。`,
    file,
  )
}

export interface CapabilityPackageManifestResolution {
  readonly entry: PackageManifestEntry;
  /** 参与防篡改比对的稳定字节摘要（本地文件字节或父清单派生条目的序列化字节）。 */
  readonly digest: string;
  readonly source: 'capability' | 'parent-workspace';
}

/**
 * 解析单个 Capability 的上传包清单，单一事实源优先：
 *
 * 1. Capability 根存在 packages.json —— 以它为准（create 生成的独立工程，capability 根即包根）。
 * 2. 否则若父目录是行业 Capability 工作区（其 packages.json 声明了本 capabilityId）——
 *    从父清单派生单能力条目 {packageId, name, capabilityIds: [self]}。派生条目的 digest
 *    只随 packageId/name/本能力成员关系变化，父清单调整其他 Capability 不影响本能力构建的新鲜度。
 * 3. 两处都没有 —— 返回 undefined，由调用方按缺清单报错。
 *
 * 父清单存在但未声明本 capabilityId 时按配置错误抛出（FH2_PACKAGE_CAPABILITY_MISMATCH），
 * 与工作区 discovery 的双向一致性门禁同一语义。
 */
export function resolveCapabilityPackageManifest (
  capabilityRoot: string,
  capabilityId: string,
): CapabilityPackageManifestResolution | undefined {
  const localFile = packageManifestPath(capabilityRoot)
  if (existsSync(localFile)) {
    const entry = readPackageManifest(capabilityRoot)
    assertPackageMatchesCapability(entry, capabilityId, localFile)
    return { entry, digest: digestBytes(readFileSync(localFile)), source: 'capability' }
  }

  const parentRoot = dirname(capabilityRoot)
  const parentFile = packageManifestPath(parentRoot)
  if (!existsSync(parentFile)) return undefined
  const parentEntry = readPackageManifest(parentRoot)
  if (!parentEntry.capabilityIds.includes(capabilityId)) {
    throw new PackageError(
      'FH2_PACKAGE_CAPABILITY_MISMATCH',
      `${parentFile} 的 capabilityIds [${parentEntry.capabilityIds.join(', ')}] 未声明当前 Capability：${capabilityId}。`,
      parentFile,
    )
  }
  const derived: PackageManifestEntry = Object.freeze({
    packageId: parentEntry.packageId,
    name: parentEntry.name,
    capabilityIds: Object.freeze([capabilityId]),
  })
  return {
    entry: derived,
    digest: digestBytes(Buffer.from(serializePackageManifest(derived), 'utf8')),
    source: 'parent-workspace',
  }
}

function digestBytes (data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function assertNonEmptyString (value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PackageError('FH2_PACKAGE_MANIFEST_INVALID', `${file} 缺少非空 ${field}。`, file)
  }
  return value
}

function assertCapabilityIds (value: unknown, file: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PackageError(
      'FH2_PACKAGE_MANIFEST_INVALID',
      `${file} 缺少非空 capabilityIds 数组。`,
      file,
    )
  }
  const seen = new Set<string>()
  const capabilityIds: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PackageError(
        'FH2_PACKAGE_MANIFEST_INVALID',
        `${file} 的 capabilityIds 必须是非空字符串数组。`,
        file,
      )
    }
    if (seen.has(item)) {
      throw new PackageError(
        'FH2_PACKAGE_MANIFEST_INVALID',
        `${file} 的 capabilityIds 存在重复：${item}。`,
        file,
      )
    }
    seen.add(item)
    capabilityIds.push(item)
  }
  return Object.freeze(capabilityIds)
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
