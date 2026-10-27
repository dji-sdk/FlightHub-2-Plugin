// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { importKnowledge, listInstalled } from './install.js'
import { buildKnowledgePackage } from './test-fixture.js'

/**
 * 从**归档**安装（计划 §A5 的消费侧）。
 *
 * ★★ 归档是信任边界：包可能来自任何地方。这组用例守的是「写盘之前就拦住」——
 * 只靠解包后的摘要校验是不够的，那时恶意文件已经写出去了。
 */

let cache: string

beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), 'fh2-kb-cache-'))
  process.env.FH2_KNOWLEDGE_CACHE = cache
})

/** 造一个 tar 块（USTAR，普通文件）。 */
function tarEntry (name: string, content: string, typeFlag = '0'): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('000644 \0', 100, 8, 'utf8')
  header.write('000000 \0', 108, 8, 'utf8')
  header.write('000000 \0', 116, 8, 'utf8')
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')} `, 124, 12, 'utf8')
  header.write('00000000000 ', 136, 12, 'utf8')
  header.write(typeFlag, 156, 1, 'utf8')
  header.write('ustar\0' + '00', 257, 8, 'utf8')
  // checksum：先填空格再算总和（tar 的规定）。
  header.write(' '.repeat(8), 148, 8, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')

  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512)
  body.write(content, 0, 'utf8')
  return Buffer.concat([header, body])
}

function tarGz (entries: readonly Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]))
}

/** 把 fixture 目录打成一个**合法**的 tar.gz（顶层目录 = knowledgeId）。 */
async function packFixture (): Promise<string> {
  const pkg = await buildKnowledgePackage()
  const { readFileSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(join(pkg.directory, 'knowledge.json'), 'utf8')) as {
    knowledgeId: string;
    files: { path: string }[];
  }
  const blocks = [tarEntry(
    `${manifest.knowledgeId}/knowledge.json`,
    readFileSync(join(pkg.directory, 'knowledge.json'), 'utf8'),
  )]
  for (const file of manifest.files) {
    blocks.push(tarEntry(
      `${manifest.knowledgeId}/${file.path}`,
      readFileSync(join(pkg.directory, file.path), 'utf8'),
    ))
  }
  const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'kb.tar.gz')
  await writeFile(archive, tarGz(blocks))
  return archive
}

describe('从归档安装', () => {
  it('合法归档装得上，且与目录安装走同一条校验', async () => {
    const installed = await importKnowledge({ source: await packFixture() })
    expect(installed.knowledgeId).toBe('bpk-test')
    expect(installed.directory.startsWith(cache)).toBe(true)
    // 逐文件摘要在解包后又跑了一遍（与目录来源同一条路径）。
    expect(installed.manifest.files.length).toBeGreaterThan(0)
  })

  it('归档里的内容被改过 → 摘要校验拦住', async () => {
    const pkg = await buildKnowledgePackage()
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(readFileSync(join(pkg.directory, 'knowledge.json'), 'utf8')) as {
      knowledgeId: string;
      files: { path: string }[];
    }
    const blocks = [tarEntry(`${manifest.knowledgeId}/knowledge.json`, readFileSync(join(pkg.directory, 'knowledge.json'), 'utf8'))]
    for (const file of manifest.files) {
      const content = file.path === 'catalog/actions.json'
        ? '[]\n' // 被掉包
        : readFileSync(join(pkg.directory, file.path), 'utf8')
      blocks.push(tarEntry(`${manifest.knowledgeId}/${file.path}`, content))
    }
    const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'kb.tar.gz')
    await writeFile(archive, tarGz(blocks))

    await expect(importKnowledge({ source: archive })).rejects.toThrow(/摘要不符|实际 \d+ 字节/)
    expect(await listInstalled()).toEqual([])
  })

  it('⚠️ symlink 条目一律拒绝（它能把后续写入导到目标目录之外）', async () => {
    const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'evil.tar.gz')
    // typeFlag '2' = symlink
    await writeFile(archive, tarGz([
      tarEntry('bpk-evil/knowledge.json', '{}'),
      tarEntry('bpk-evil/link', '../../../etc/passwd', '2'),
    ]))
    await expect(importKnowledge({ source: archive })).rejects.toThrow(/非普通文件|symlink/)
  })

  it('⚠️ 硬链接与设备节点同样拒绝', async () => {
    for (const flag of ['1', '3', '4']) {
      const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'evil.tar.gz')
      await writeFile(archive, tarGz([
        tarEntry('bpk-evil/knowledge.json', '{}'),
        tarEntry('bpk-evil/node', 'x', flag),
      ]))
      await expect(importKnowledge({ source: archive }), `typeFlag ${flag}`)
        .rejects.toThrow(/非普通文件/)
    }
  })

  it('⚠️ 逃逸路径在**写盘之前**被拦', async () => {
    const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'evil.tar.gz')
    await writeFile(archive, tarGz([
      tarEntry('bpk-evil/knowledge.json', '{}'),
      tarEntry('bpk-evil/../../escaped.txt', 'pwned'),
    ]))
    await expect(importKnowledge({ source: archive })).rejects.toThrow(/\.\.|逃逸|含空段/)
  })

  it('条目不在同一个顶层目录下 → 不像知识包，拒绝', async () => {
    const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'mixed.tar.gz')
    await writeFile(archive, tarGz([
      tarEntry('a/knowledge.json', '{}'),
      tarEntry('b/other.json', '{}'),
    ]))
    await expect(importKnowledge({ source: archive })).rejects.toThrow(/同一个顶层目录/)
  })

  it('空归档报错而不是装出一个空知识包', async () => {
    const archive = join(await mkdtemp(join(tmpdir(), 'fh2-arc-')), 'empty.tar.gz')
    await writeFile(archive, tarGz([]))
    await expect(importKnowledge({ source: archive })).rejects.toThrow(/没有任何文件/)
  })
})
