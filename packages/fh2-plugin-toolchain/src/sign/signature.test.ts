// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SIGNATURE_ENTRY_NAME,
  collectPackageFiles,
  digestPackageFiles,
  serializePackageSignature,
  verifyPackageSignature,
} from './signature.js'
import type { PackageSignature } from './signature.js'

/**
 * 语义用例对齐平台插件管理服务的 Go 侧签名测试：
 * 摘要确定性 / 路径与内容敏感性 / SIGNATURE 自排除 / 验签正反例 /
 * 篡改一字节必失败 / 构造顺序无关 / 零过滤（新增 .DS_Store 参与即失败）。
 * 差异：Go 侧噪声排除在打包签名入口（collectFiles），本文件对应验证 collectPackageFiles。
 */

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function toKeyObject (privateKey: Buffer) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, privateKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
}

function generateKeyPair (): { readonly privateKey: Buffer; readonly publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  // Node 导出的 PKCS8/SPKI 是 DER 封装；还原成与交接物一致的原始字节形态
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const seed = pkcs8.subarray(pkcs8.byteLength - 32)
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const rawPublic = spki.subarray(spki.byteLength - 32)
  return { privateKey: Buffer.concat([seed, rawPublic]), publicKey: rawPublic }
}

function baseFiles (): Map<string, Buffer> {
  return new Map<string, Buffer>([
    ['packages.json', Buffer.from('{"name":"demo"}')],
    ['capabilities/backend/main.js', Buffer.from('console.log(1)')],
    ['capabilities/frontend/app.js', Buffer.from('console.log(\'hi\')')],
  ])
}

function buildSignature (privateKey: Buffer, files: ReadonlyMap<string, Buffer>, overrides: Partial<PackageSignature> = {}): Buffer {
  const digest = digestPackageFiles(files)
  const sig = nodeSign(null, digest, toKeyObject(privateKey))
  return serializePackageSignature({ alg: 'ed25519', sig, keyId: 'test-key', digestVer: 'v1', ...overrides })
}

function copyFiles (files: ReadonlyMap<string, Buffer>): Map<string, Buffer> {
  return new Map(files)
}

describe('digestPackageFiles', () => {
  it('确定性：相同输入两次计算摘要一致', () => {
    const files = baseFiles()
    expect(digestPackageFiles(files).equals(digestPackageFiles(copyFiles(files)))).toBe(true)
  })

  it('仅改文件路径（内容不变）→ 摘要变化', () => {
    const original = baseFiles()
    const renamed = copyFiles(original)
    renamed.set('packages2.json', renamed.get('packages.json')!)
    renamed.delete('packages.json')
    expect(digestPackageFiles(original).equals(digestPackageFiles(renamed))).toBe(false)
  })

  it('仅改文件内容 → 摘要变化', () => {
    const original = baseFiles()
    const modified = copyFiles(original)
    modified.set('packages.json', Buffer.from('{"name":"demo2"}'))
    expect(digestPackageFiles(original).equals(digestPackageFiles(modified))).toBe(false)
  })

  it('sIGNATURE 条目不参与摘要', () => {
    const files = baseFiles()
    const without = digestPackageFiles(files)
    const withNoise = copyFiles(files)
    withNoise.set(SIGNATURE_ENTRY_NAME, Buffer.from('not even json'))
    expect(digestPackageFiles(withNoise).equals(without)).toBe(true)
  })

  it('路径排序按 UTF-8 字节字典序（非 UTF-16 code unit 序）', () => {
    // U+FF21（Ａ）在 UTF-16 是 0xFF21，但 UTF-8 首字节 0xEF；'z' 是 0x7A。
    // UTF-16 序：'z' < 'Ａ'；字节序：'z'(0x7A) < 'Ａ'(0xEF..)。构造两个仅顺序不同的集合，
    // 摘要必须一致（排序是 digest 内部行为，与插入顺序无关）。
    const a = new Map([['z.js', Buffer.from('1')], ['Ａ.js', Buffer.from('2')]])
    const b = new Map([['Ａ.js', Buffer.from('2')], ['z.js', Buffer.from('1')]])
    expect(digestPackageFiles(a).equals(digestPackageFiles(b))).toBe(true)
  })
})

describe('verifyPackageSignature', () => {
  it('正确签名 + 正确公钥 → 通过', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    expect(verifyPackageSignature(files, publicKey)).toBe(true)
  })

  it('公钥列表换成不相关公钥 → 失败', () => {
    const { privateKey } = generateKeyPair()
    const other = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    expect(verifyPackageSignature(files, other.publicKey)).toBe(false)
  })

  it('缺少 SIGNATURE 条目 → 失败', () => {
    const { publicKey } = generateKeyPair()
    expect(verifyPackageSignature(baseFiles(), publicKey)).toBe(false)
  })

  it('sIGNATURE 非法 JSON → 失败', () => {
    const { publicKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, Buffer.from('{{{'))
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('alg 非白名单 → 失败', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const files = baseFiles()
    const digest = digestPackageFiles(files)
    const sig = nodeSign(null, digest, toKeyObject(privateKey))
    // alg 伪造为 rsa：签名本身有效但算法不在白名单
    files.set(SIGNATURE_ENTRY_NAME, Buffer.from(JSON.stringify({
      alg: 'rsa',
      sig: sig.toString('base64'),
      keyId: 'test-key',
      digestVer: 'v1',
    })))
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('sig 是 urlsafe base64 → 失败（服务端按标准字母表解码）', () => {
    const { publicKey } = generateKeyPair()
    const files = baseFiles()
    // ★ 不用随机签名：64 字节随机签名约 6.5% 概率（(62/64)^86）base64 完全不含 +/，
    //   replaceAll 空转后「urlsafe」与标准字母表串相同，用例偶发通过（CI 已实测命中）。
    //   用 0xFB/0xFF 交替填充：每个 6-bit 组 ∈ {59,62,63}，base64 必然含 + 与 /，
    //   转 urlsafe 后必然含 - 与 _。判定门 isStandardBase64 在验签之前，sig 字节无需是真实签名。
    const sigBytes = Buffer.alloc(64)
    for (let index = 0; index < 64; index += 1) sigBytes[index] = index % 2 === 0 ? 0xFB : 0xFF
    const urlsafe = sigBytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_')
    if (!urlsafe.includes('-') && !urlsafe.includes('_')) throw new Error('测试构造失败：urlsafe 串未含 -/_')
    files.set(SIGNATURE_ENTRY_NAME, Buffer.from(JSON.stringify({
      alg: 'ed25519',
      sig: urlsafe,
      keyId: 'test-key',
      digestVer: 'v1',
    })))
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('签名后篡改一个文件的一个字节 → 失败', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    const tampered = Buffer.from(files.get('packages.json')!)
    const lastIndex = tampered.byteLength - 1
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 0xFF
    files.set('packages.json', tampered)
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('内容不变、构造顺序不同（模拟重新打包）→ 仍通过', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    const rebuilt = new Map<string, Buffer>()
    for (const key of [...files.keys()].reverse()) rebuilt.set(key, files.get(key)!)
    expect(verifyPackageSignature(rebuilt, publicKey)).toBe(true)
  })

  it('签名后新增文件（零过滤）→ 失败', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    files.set('extra.txt', Buffer.from('junk'))
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('公钥长度非法 → 失败且不抛错', () => {
    const { privateKey } = generateKeyPair()
    const files = baseFiles()
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    expect(verifyPackageSignature(files, Buffer.from('too-short'))).toBe(false)
  })
})

describe('collectPackageFiles', () => {
  const temporaryRoots: string[] = []

  function createTemporaryDirectory (): string {
    const root = join(tmpdir(), `fh2-sign-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    temporaryRoots.push(root)
    return root
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('只收文件不收目录；路径 / 分隔、无前导 /', () => {
    const root = createTemporaryDirectory()
    mkdirSync(join(root, 'official_demo/frontend/plugin'), { recursive: true })
    writeFileSync(join(root, 'packages.json'), 'p')
    writeFileSync(join(root, 'official_demo/frontend/plugin/plugin.json'), 'f')
    const files = collectPackageFiles(root)
    expect([...files.keys()].sort()).toEqual([
      'official_demo/frontend/plugin/plugin.json',
      'packages.json',
    ])
  })

  it('噪声排除发生在收集阶段：.DS_Store 文件与 __MACOSX/.git 整目录不进文件表', () => {
    const root = createTemporaryDirectory()
    writeFileSync(join(root, 'packages.json'), 'p')
    writeFileSync(join(root, '.DS_Store'), 'noise')
    mkdirSync(join(root, '__MACOSX'), { recursive: true })
    writeFileSync(join(root, '__MACOSX/bundled'), 'noise')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git/config'), 'noise')
    // 路径段精确匹配：.gitignore 文件、my.git.txt 不误伤
    writeFileSync(join(root, '.gitignore'), 'keep')
    writeFileSync(join(root, 'my.git.txt'), 'keep')
    const files = collectPackageFiles(root)
    expect([...files.keys()].sort()).toEqual(['.gitignore', 'my.git.txt', 'packages.json'])
  })

  it('噪声排除发生在摘要之前：签名后的包里补进 .DS_Store 验签必失败（与零过滤同源）', () => {
    const root = createTemporaryDirectory()
    writeFileSync(join(root, 'packages.json'), 'p')
    const { privateKey, publicKey } = generateKeyPair()
    const files = collectPackageFiles(root)
    files.set(SIGNATURE_ENTRY_NAME, buildSignature(privateKey, files))
    expect(verifyPackageSignature(files, publicKey)).toBe(true)
    files.set('.DS_Store', Buffer.from('late noise'))
    expect(verifyPackageSignature(files, publicKey)).toBe(false)
  })

  it('空目录 → 空文件表（由调用方按 FH2_SIGN_INPUT_EMPTY 拦截）', () => {
    const root = createTemporaryDirectory()
    expect(collectPackageFiles(root).size).toBe(0)
  })
})

describe('serializePackageSignature', () => {
  it('jSON 字段顺序固定 alg/sig/keyId/digestVer（对齐 Go json.Marshal 结构体顺序）', () => {
    const { privateKey } = generateKeyPair()
    const digest = Buffer.alloc(32, 1)
    const sig = nodeSign(null, digest, toKeyObject(privateKey))
    const json = serializePackageSignature({ alg: 'ed25519', sig, keyId: 'demo-2026-09', digestVer: 'v1' }).toString('utf8')
    expect(json).toBe(JSON.stringify({
      alg: 'ed25519',
      sig: sig.toString('base64'),
      keyId: 'demo-2026-09',
      digestVer: 'v1',
    }))
  })
})
