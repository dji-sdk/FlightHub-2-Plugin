// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * 官方插件包签名核心（plugin-sign/readme §4 规格的 Node 移植，
 * 权威源：平台插件管理服务的 Go 实现（安装验签 + 官方打包签名））。
 *
 * 摘要与验签口径的反直觉细节全部对齐 Go 实现：
 * - 噪声排除（.DS_Store 文件 / __MACOSX、.git 整目录）必须发生在算摘要**之前**，
 *   保证「签名时的文件集合」与「服务端解压出的文件集合」逐字节一致；
 * - 摘要零过滤（只排除 SIGNATURE 自己）；路径按 UTF-8 字节字典序排序；
 * - 签名对象是 32 字节 digest 本身（非 hex、非预哈希变体）；
 * - alg 白名单只有 ed25519，白名单外一律验签失败（对应服务端静默判生态）。
 */

export const SIGNATURE_ENTRY_NAME = 'SIGNATURE'

export interface PluginSignDiagnostic {
  readonly code: string;
  readonly message: string;
}

export class PluginSignError extends Error {
  readonly diagnostic: PluginSignDiagnostic

  constructor (diagnostic: PluginSignDiagnostic) {
    super(diagnostic.message)
    this.name = 'PluginSignError'
    this.diagnostic = diagnostic
  }
}

function signError (code: string, message: string): PluginSignError {
  return new PluginSignError({ code, message })
}

export interface PackageSignature {
  readonly alg: 'ed25519';
  /** 64 字节 ed25519 签名 */
  readonly sig: Buffer;
  readonly keyId: string;
  readonly digestVer: 'v1';
}

/** 整目录排除：按路径段精确匹配（`.gitignore`、`my.git.txt` 不误伤）。 */
const NOISE_DIRECTORY_NAMES = new Set(['__MACOSX', '.git'])
/** 文件排除：任意层级、文件名恰好为 `.DS_Store`。 */
const NOISE_FILE_NAMES = new Set(['.DS_Store'])

/**
 * 遍历待签名目录并应用噪声排除，返回 `包内路径 -> 内容` 的文件表。
 * 包内路径始终 `/` 分隔、无前导 `/` 与 `./`（与服务端 path.Clean 后的形态一致）。
 * 只收文件不收目录（目录条目不参与摘要也不进 zip）。
 */
export function collectPackageFiles (root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const absoluteRoot = resolve(root)
  visitDirectory(absoluteRoot, absoluteRoot, files)
  return files
}

function visitDirectory (absoluteRoot: string, directory: string, files: Map<string, Buffer>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (NOISE_DIRECTORY_NAMES.has(entry.name)) continue
      visitDirectory(absoluteRoot, join(directory, entry.name), files)
      continue
    }
    if (!entry.isFile() || NOISE_FILE_NAMES.has(entry.name)) continue
    const absolute = join(directory, entry.name)
    const packagePath = relative(absoluteRoot, absolute).split(sep).join('/')
    if (packagePath === '' || packagePath.startsWith('/')) {
      throw signError('FH2_SIGN_PATH_UNSAFE', `待签名文件路径不安全：${absolute}`)
    }
    files.set(packagePath, readFileSync(absolute))
  }
}

/**
 * 摘要（SHA-256）：对每个文件按 `路径字节 + 0x00 + 8 字节大端内容长度 + 内容`
 * 拼接哈希。只排除 SIGNATURE 自己，其余零过滤；路径按 UTF-8 字节字典序排序
 * （非 locale / UTF-16 排序，与 Go sort.Strings 逐字节语义一致）。
 * 分隔符 + 长度前缀消除 `path="ab",content="c"` 与 `path="a",content="bc"` 的拼接碰撞。
 */
export function digestPackageFiles (files: ReadonlyMap<string, Buffer>): Buffer {
  const keys = [...files.keys()]
    .filter(key => key !== SIGNATURE_ENTRY_NAME)
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
  const hash = createHash('sha256')
  const lengthBytes = Buffer.alloc(8)
  for (const key of keys) {
    const content = files.get(key)!
    hash.update(key, 'utf8')
    hash.update(Buffer.from([0x00]))
    lengthBytes.writeBigUInt64BE(BigInt(content.byteLength))
    hash.update(lengthBytes)
    hash.update(content)
  }
  return hash.digest()
}

// ed25519 原始字节 → Node crypto KeyObject 的 DER 封装前缀。
// 私钥 PKCS8：ED25519 私钥 PKCS8 只封装 32 字节 seed（原始 64 字节 = seed + 公钥）。
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** 用 64 字节原始 ed25519 私钥对 digest（32 字节）直接签名；非预哈希变体。 */
export function signDigest (privateKey: Buffer, digest: Buffer): Buffer {
  if (privateKey.byteLength !== 64) {
    throw signError('FH2_SIGN_PRIVATE_KEY_LENGTH', `私钥长度 ${privateKey.byteLength} 字节，期望 64 字节`)
  }
  const keyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, privateKey.subarray(0, 32)]), format: 'der', type: 'pkcs8' })
  return cryptoSign(null, digest, keyObject)
}

/** 用 32 字节原始 ed25519 公钥验签（alg 白名单 + 长度守卫在 verifyPackageSignature 内）。 */
function verifyDigest (publicKey: Buffer, digest: Buffer, sig: Buffer): boolean {
  if (publicKey.byteLength !== 32 || sig.byteLength !== 64) return false
  const keyObject = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' })
  return cryptoVerify(null, digest, keyObject, sig)
}

/**
 * 按服务端 Verify 的判定顺序验签：SIGNATURE 条目存在且为合法 JSON →
 * alg 是 ed25519 白名单 → sig 可按标准 base64 解开 → 摘要匹配。
 * 任一不满足返回 false（对应服务端静默判生态，不抛错）。
 */
export function verifyPackageSignature (files: ReadonlyMap<string, Buffer>, publicKey: Buffer): boolean {
  const signatureEntry = files.get(SIGNATURE_ENTRY_NAME)
  if (signatureEntry === undefined) return false
  const parsed = parsePackageSignature(signatureEntry)
  if (parsed === null) return false
  return verifyDigest(publicKey, digestPackageFiles(files), parsed.sig)
}

/** SIGNATURE 文件内容（JSON 字段顺序固定为 alg/sig/keyId/digestVer，对齐 Go json.Marshal 结构体顺序）。 */
export function serializePackageSignature (signature: PackageSignature): Buffer {
  return Buffer.from(JSON.stringify({
    alg: signature.alg,
    sig: signature.sig.toString('base64'),
    keyId: signature.keyId,
    digestVer: signature.digestVer,
  }), 'utf8')
}

/** 解析 SIGNATURE 条目：alg 白名单、sig 标准 base64 64 字节、digestVer v1，任一不符返回 null。 */
export function parsePackageSignature (content: Buffer): PackageSignature | null {
  let value: unknown
  try {
    value = JSON.parse(content.toString('utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.alg !== 'ed25519' || record.digestVer !== 'v1') return null
  if (typeof record.sig !== 'string' || typeof record.keyId !== 'string') return null
  if (!isStandardBase64(record.sig) || Buffer.from(record.sig, 'base64').byteLength !== 64) return null
  return { alg: 'ed25519', sig: Buffer.from(record.sig, 'base64'), keyId: record.keyId, digestVer: 'v1' }
}

function isStandardBase64 (value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0
}
