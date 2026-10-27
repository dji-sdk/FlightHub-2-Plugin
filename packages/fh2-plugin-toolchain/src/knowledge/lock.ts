// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 项目知识锁：`backend-plugin-knowledge.lock.json`。
 *
 * ★★ lock 只含 `knowledgeId` + `bundleDigest`，**不含 URL、凭据或任何执行路径**
 * （方案 §3.2.2 / 计划 §B2）。理由是攻击面：锁文件跟着 Git 走，任何人都能改它。
 * 它里面出现一条路径，就等于「改一行 JSON 就能让别人的 Toolchain 去执行任意文件」。
 *
 * 身份要两格而不是一格：只有 ID 时，两份不同内容用同一个 ID（脏工作区产物）没法分辨；
 * 只有摘要时，人看不出锁的是哪一版。ID 给人读，摘要给机器判。
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KNOWLEDGE_LOCK_FILENAME, KNOWLEDGE_LOCK_FORMAT_VERSION } from '../contracts/knowledge.js'
import type { KnowledgeLock } from '../contracts/knowledge.js'

export class KnowledgeLockError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'KnowledgeLockError'
  }
}

export function lockFilePath (projectRoot: string): string {
  return join(projectRoot, KNOWLEDGE_LOCK_FILENAME)
}

/** 读项目锁。没有锁文件回 undefined（未固定知识不是错误）；锁文件坏了才报错。 */
export function readLock (projectRoot: string): KnowledgeLock | undefined {
  const file = lockFilePath(projectRoot)
  if (!existsSync(file)) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    throw new KnowledgeLockError(`${KNOWLEDGE_LOCK_FILENAME} 不是合法 JSON：${(error as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KnowledgeLockError(`${KNOWLEDGE_LOCK_FILENAME} 顶层不是对象`)
  }
  const record = raw as Record<string, unknown>
  if (record.formatVersion !== KNOWLEDGE_LOCK_FORMAT_VERSION) {
    throw new KnowledgeLockError(
      `${KNOWLEDGE_LOCK_FILENAME} 的 formatVersion=${String(record.formatVersion)} 不受支持`
      + `（本 Toolchain 只认 ${KNOWLEDGE_LOCK_FORMAT_VERSION}）`,
    )
  }
  if (typeof record.knowledgeId !== 'string' || record.knowledgeId === '') {
    throw new KnowledgeLockError(`${KNOWLEDGE_LOCK_FILENAME} 缺少 knowledgeId`)
  }
  if (typeof record.bundleDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.bundleDigest)) {
    throw new KnowledgeLockError(`${KNOWLEDGE_LOCK_FILENAME} 的 bundleDigest 不是 64 位小写 hex`)
  }
  // 多余字段直接拒：URL / token / checkerPath 一类的东西出现在这里必须是显式错误，
  // 不能被安静忽略后让人以为「写了就生效」。
  const allowed = new Set(['formatVersion', 'knowledgeId', 'bundleDigest'])
  const extra = Object.keys(record).filter(key => !allowed.has(key))
  if (extra.length > 0) {
    throw new KnowledgeLockError(
      `${KNOWLEDGE_LOCK_FILENAME} 含未知字段 ${extra.join(' / ')}。`
      + 'lock 只允许 knowledgeId 与 bundleDigest —— URL、凭据和可执行路径一律不进锁文件。',
    )
  }
  return {
    formatVersion: KNOWLEDGE_LOCK_FORMAT_VERSION,
    knowledgeId: record.knowledgeId,
    bundleDigest: record.bundleDigest,
  }
}

/** 写项目锁。固定缩进 + 末尾换行：它进 Git，格式抖动会制造无意义 diff。 */
export async function writeLock (projectRoot: string, lock: Omit<KnowledgeLock, 'formatVersion'>): Promise<KnowledgeLock> {
  const next: KnowledgeLock = {
    formatVersion: KNOWLEDGE_LOCK_FORMAT_VERSION,
    knowledgeId: lock.knowledgeId,
    bundleDigest: lock.bundleDigest,
  }
  const body = `${JSON.stringify(next, null, 2)}\n`
  await writeFile(lockFilePath(projectRoot), body, 'utf8')
  return next
}
