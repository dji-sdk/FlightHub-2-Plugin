// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  KnowledgeInstallError,
  computeBundleDigest,
  findInstalled,
  importKnowledge,
  listInstalled,
  parseManifest,
} from './install.js'
import { buildKnowledgePackage } from './test-fixture.js'

/**
 * 安装校验是整条消费链的**唯一**把关点：装进来之后 catalog / schema / types
 * 都按身份直接读、不再复查。故这里每一条用例守的都是一种「装进来的东西不是它自称的那样」。
 */
describe('knowledge/install', () => {
  let cache: string

  beforeEach(async () => {
    cache = await mkdtemp(join(tmpdir(), 'fh2-kb-cache-'))
    process.env.FH2_KNOWLEDGE_CACHE = cache
  })

  it('bundleDigest 就是 knowledge.json 的原始字节哈希', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    expect(installed.bundleDigest).toBe(computeBundleDigest(readFileSync(join(pkg.directory, 'knowledge.json'))))
  })

  it('装好后能按 id 找回，且缓存目录在受控根下', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    expect(installed.directory.startsWith(cache)).toBe(true)
    expect((await findInstalled(installed.knowledgeId))?.bundleDigest).toBe(installed.bundleDigest)
    expect((await listInstalled()).map(item => item.knowledgeId)).toEqual([installed.knowledgeId])
  })

  it('同 id 同内容重复安装是幂等成功', async () => {
    const pkg = await buildKnowledgePackage()
    const first = await importKnowledge({ source: pkg.directory })
    const second = await importKnowledge({ source: pkg.directory })
    expect(second.bundleDigest).toBe(first.bundleDigest)
  })

  it('同 id 不同内容默认拒绝，--force 才替换', async () => {
    const first = await buildKnowledgePackage()
    await importKnowledge({ source: first.directory })
    // 同一个 knowledgeId、不同 catalog 内容：只有脏工作区产物会这样。
    const second = await buildKnowledgePackage({ extraAction: 'other_step' })
    await expect(importKnowledge({ source: second.directory })).rejects.toThrow(/已有.*内容不同/s)
    const forced = await importKnowledge({ source: second.directory, force: true })
    expect(forced.bundleDigest).not.toBe((await parseManifest(readFileSync(join(first.directory, 'knowledge.json')))).bundleDigest)
  })

  it('任一载荷被改过就拒绝安装', async () => {
    const pkg = await buildKnowledgePackage()
    await writeFile(join(pkg.directory, 'catalog/actions.json'), '[]', 'utf8')
    await expect(importKnowledge({ source: pkg.directory })).rejects.toThrow(/摘要不符|实际 \d+ 字节/)
  })

  it('目录里多出一份清单外的文件就拒绝 —— 它不受摘要保护', async () => {
    const pkg = await buildKnowledgePackage()
    await writeFile(join(pkg.directory, 'docs/sneaky.md'), '# 不在 files[] 里', 'utf8')
    await expect(importKnowledge({ source: pkg.directory })).rejects.toThrow(/但清单里没有它/)
  })

  it('校验失败时缓存里不留半截目录', async () => {
    const pkg = await buildKnowledgePackage()
    await writeFile(join(pkg.directory, 'catalog/actions.json'), '[]', 'utf8')
    await expect(importKnowledge({ source: pkg.directory })).rejects.toThrow()
    expect(await listInstalled()).toEqual([])
  })

  it('格式版本或协议版本不支持时拒绝，不尽力解析', () => {
    const base = {
      formatVersion: 1,
      knowledgeId: 'k',
      workerRevision: 'r',
      contractsVersion: '1.1.0',
      gojaVersion: 'g',
      toolchainProtocolVersion: 1,
      files: [{ path: 'a', sha256: 'x', bytes: 1 }],
      checkers: [],
    }
    const bytes = (patch: Record<string, unknown>): Buffer =>
      Buffer.from(JSON.stringify({ ...base, ...patch }), 'utf8')

    expect(() => parseManifest(bytes({ formatVersion: 2 }))).toThrow(/格式版本 2 不受支持/)
    expect(() => parseManifest(bytes({ toolchainProtocolVersion: 9 }))).toThrow(/toolchainProtocolVersion=9/)
  })

  it('checkers 缺字段与空数组不是一回事', () => {
    const withoutCheckers = {
      formatVersion: 1,
      knowledgeId: 'k',
      workerRevision: 'r',
      contractsVersion: '1.1.0',
      gojaVersion: 'g',
      toolchainProtocolVersion: 1,
      files: [{ path: 'a', sha256: 'x', bytes: 1 }],
    }
    expect(() => parseManifest(Buffer.from(JSON.stringify(withoutCheckers), 'utf8')))
      .toThrow(/缺少 checkers/)
    // 空数组合法：它是显式的「本次没构建任何 checker」。
    expect(() => parseManifest(Buffer.from(JSON.stringify({ ...withoutCheckers, checkers: [] }), 'utf8')))
      .not.toThrow()
  })

  it('files[] 里的逃逸路径、重复路径和 knowledge.json 自身都拒绝', async () => {
    for (const [path, pattern] of [
      ['../escape.md', /含 \. \/ \.\. 或空段/],
      ['/abs.md', /不允许绝对路径/],
      ['a\\b.md', /必须用 \/ 分隔/],
      ['knowledge.json', /不该包含 knowledge.json 自身/],
    ] as const) {
      const pkg = await buildKnowledgePackage({ injectFileEntry: path })
      await expect(importKnowledge({ source: pkg.directory }), path).rejects.toThrow(pattern)
    }
  })

  it('来源不是知识包目录时报得具体', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'fh2-not-kb-'))
    await expect(importKnowledge({ source: empty })).rejects.toThrow(/没有 knowledge.json/)
    await expect(importKnowledge({ source: join(empty, 'nope') })).rejects.toThrow(/来源不存在/)
  })

  it('坏归档报解压失败，且不在缓存里留半份', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fh2-tar-'))
    const archive = join(dir, 'kb.tar.gz')
    await writeFile(archive, 'not really a tarball', 'utf8')
    await expect(importKnowledge({ source: archive })).rejects.toThrow(/解压失败/)
    expect(await listInstalled()).toEqual([])
  })

  it('knowledgeInstallError 是可识别类型（调用方要据此分辨「用户输入错」与「程序缺陷」）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'fh2-not-kb2-'))
    await expect(importKnowledge({ source: empty })).rejects.toBeInstanceOf(KnowledgeInstallError)
  })
})
