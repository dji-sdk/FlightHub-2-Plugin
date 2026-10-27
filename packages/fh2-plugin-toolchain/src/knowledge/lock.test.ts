// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { KNOWLEDGE_LOCK_FILENAME } from '../contracts/knowledge.js'
import { KnowledgeLockError, lockFilePath, readLock, writeLock } from './lock.js'

/**
 * 锁文件跟着 Git 走，任何人都能改它。故这里守两件事：
 *   ① 身份两格（id 给人读、摘要给机器判）都必须在且形状正确
 *   ② **多余字段一律拒**——URL / token / checkerPath 出现在锁里必须是显式错误
 */
describe('knowledge/lock', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fh2-lock-'))
  })

  const write = async (body: unknown): Promise<void> => {
    await writeFile(lockFilePath(root), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  }

  it('没有锁文件回 undefined —— 未固定知识不是错误', () => {
    expect(readLock(root)).toBeUndefined()
  })

  it('写了能读回来，且带固定 formatVersion', async () => {
    const digest = 'a'.repeat(64)
    const written = await writeLock(root, { knowledgeId: 'bpk-1', bundleDigest: digest })
    expect(written.formatVersion).toBe(1)
    expect(readLock(root)).toEqual({ formatVersion: 1, knowledgeId: 'bpk-1', bundleDigest: digest })
  })

  it('写出的文件是 2 空格缩进 + 末尾换行（它进 Git，格式抖动制造无意义 diff）', async () => {
    await writeLock(root, { knowledgeId: 'bpk-1', bundleDigest: 'b'.repeat(64) })
    const { readFileSync } = await import('node:fs')
    const body = readFileSync(lockFilePath(root), 'utf8')
    expect(body.endsWith('\n')).toBe(true)
    expect(body).toContain('\n  "knowledgeId"')
  })

  it('坏 JSON、非对象、错 formatVersion 都报得具体', async () => {
    await write('{ 不是 JSON')
    expect(() => readLock(root)).toThrow(/不是合法 JSON/)

    await write([1, 2])
    expect(() => readLock(root)).toThrow(/顶层不是对象/)

    await write({ formatVersion: 99, knowledgeId: 'k', bundleDigest: 'c'.repeat(64) })
    expect(() => readLock(root)).toThrow(/formatVersion=99 不受支持/)
  })

  it('缺 knowledgeId 或摘要形状不对就报错', async () => {
    await write({ formatVersion: 1, bundleDigest: 'd'.repeat(64) })
    expect(() => readLock(root)).toThrow(/缺少 knowledgeId/)

    await write({ formatVersion: 1, knowledgeId: 'k', bundleDigest: 'not-hex' })
    expect(() => readLock(root)).toThrow(/64 位小写 hex/)

    // 大写 hex 也拒：摘要要能逐字节比对，两种大小写会让比对偶尔失败。
    await write({ formatVersion: 1, knowledgeId: 'k', bundleDigest: 'A'.repeat(64) })
    expect(() => readLock(root)).toThrow(/64 位小写 hex/)
  })

  it('锁里出现 URL / 凭据 / 可执行路径一律显式拒绝，不安静忽略', async () => {
    for (const extra of [
      { registryUrl: 'https://evil.example/kb.tar.gz' },
      { token: 'secret' },
      { checkerPath: '/tmp/evil' },
    ]) {
      await write({ formatVersion: 1, knowledgeId: 'k', bundleDigest: 'e'.repeat(64), ...extra })
      expect(() => readLock(root), JSON.stringify(extra)).toThrow(/含未知字段/)
    }
  })

  it('抛的是 KnowledgeLockError（调用方要把它显示成阻断项而不是崩栈）', async () => {
    await write('nope')
    expect(() => readLock(root)).toThrow(KnowledgeLockError)
  })

  it('锁文件名固定，供工程 .gitignore / 文档引用', () => {
    expect(lockFilePath(root).endsWith(KNOWLEDGE_LOCK_FILENAME)).toBe(true)
  })
})
