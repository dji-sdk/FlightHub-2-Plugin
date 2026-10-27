// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { isPathInside } from '../build/paths.js'
import { createDeterministicZip } from '../capability/zip.js'
import {
  PluginSignError,
  SIGNATURE_ENTRY_NAME,
  collectPackageFiles,
  digestPackageFiles,
  serializePackageSignature,
  signDigest,
  verifyPackageSignature,
} from './signature.js'

export { PluginSignError } from './signature.js'
export {
  KEY_ID_ENV_NAME,
  PRIVATE_KEY_BYTES,
  PRIVATE_KEY_ENV_NAME,
  PUBLIC_KEY_BYTES,
  PUBLIC_KEY_ENV_NAME,
  loadSigningKeys,
} from './keys.js'
export type { SigningKeys } from './keys.js'
export {
  SIGNATURE_ENTRY_NAME,
  collectPackageFiles,
  digestPackageFiles,
  parsePackageSignature,
  serializePackageSignature,
  signDigest,
  verifyPackageSignature,
} from './signature.js'
export type { PackageSignature, PluginSignDiagnostic } from './signature.js'

export interface SignPluginPackageOptions {
  /** pack 产物目录（顶层 packages.json + 能力目录） */
  readonly inputRoot: string;
  /** 输出 zip 路径 */
  readonly outputZipPath: string;
  /** 写入 SIGNATURE.keyId 的留痕标识（服务端不校验，轮换密钥时用于溯源） */
  readonly keyId: string;
  readonly privateKey: Buffer;
  readonly publicKey: Buffer;
}

export interface SignPluginPackageResult {
  readonly zipPath: string;
  /** zip 的 SHA-256（素材指纹：同素材同密钥两次签名逐字节相同） */
  readonly sha256: string;
  /** zip 条目数（含 SIGNATURE） */
  readonly entryCount: number;
}

/**
 * 生成官方签名安装包：收集（噪声排除先于摘要）→ 摘要 → ed25519 签名 →
 * SIGNATURE 追加进文件集合 → 确定性 zip → 原子提交。
 *
 * 产物确定性：zip 条目字典序、固定时间戳、ed25519 确定性签名——同素材 +
 * 同私钥 + 同 keyId 两次签名逐字节相同，zip 的 sha256 即素材指纹。
 */
export async function signPluginPackage (options: SignPluginPackageOptions): Promise<SignPluginPackageResult> {
  const inputRoot = resolve(options.inputRoot)
  if (!existsSync(inputRoot)) {
    throw new PluginSignError({ code: 'FH2_SIGN_INPUT_NOT_FOUND', message: `待签名目录不存在：${inputRoot}` })
  }
  const outputZipPath = resolve(options.outputZipPath)
  // 输出可以尚不存在；从最近已存在的祖先解析软链，避免别名写回输入目录。
  let outputAncestor = dirname(outputZipPath)
  const missingSegments: string[] = [basename(outputZipPath)]
  while (!existsSync(outputAncestor)) {
    const parent = dirname(outputAncestor)
    if (parent === outputAncestor) break
    missingSegments.unshift(basename(outputAncestor))
    outputAncestor = parent
  }
  const realOutput = resolve(realpathSync(outputAncestor), ...missingSegments)
  const realInput = realpathSync(inputRoot)
  if (isPathInside(inputRoot, outputZipPath) || isPathInside(realInput, realOutput)
    || (existsSync(outputZipPath) && isPathInside(realInput, realpathSync(outputZipPath)))) {
    throw new PluginSignError({
      code: 'FH2_SIGN_PATH_UNSAFE',
      message: `输出不得与输入目录相同或位于输入目录内：${outputZipPath}；请指定独立输出目录。`,
    })
  }

  // 第一步：遍历 + 噪声排除，得到「签名时的文件集合」（此刻还没有 SIGNATURE）。
  const files = collectPackageFiles(inputRoot)
  if (files.size === 0) {
    throw new PluginSignError({ code: 'FH2_SIGN_INPUT_EMPTY', message: `待签名目录没有任何可打包文件：${inputRoot}` })
  }

  // 第二步：对排除噪声后的集合算摘要、签名；签名后立即用公钥自检配对。
  const digest = digestPackageFiles(files)
  const sig = signDigest(options.privateKey, digest)
  const signatureJson = serializePackageSignature({ alg: 'ed25519', sig, keyId: options.keyId, digestVer: 'v1' })
  const verifyProbe = new Map(files)
  verifyProbe.set(SIGNATURE_ENTRY_NAME, signatureJson)
  if (!verifyPackageSignature(verifyProbe, options.publicKey)) {
    throw new PluginSignError({
      code: 'FH2_SIGN_KEY_MISMATCH',
      message: '签名自检失败：公私钥不是一对（请核对 FH2_PLUGIN_SIGN_PRIVATE_KEY 与 FH2_PLUGIN_SIGN_PUBLIC_KEY）',
    })
  }

  // 第三步：签名算完之后才把 SIGNATURE 追加进文件集合，统一写确定性 zip。
  files.set(SIGNATURE_ENTRY_NAME, signatureJson)
  const zipBuffer = createDeterministicZip([...files.entries()].map(([path, data]) => ({ path, data: Buffer.from(data) })))
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex')

  // 原子提交：先写候选文件再 rename，失败不残留半包。
  const candidatePath = resolve(dirname(outputZipPath), `.fh2-sign-next-${randomUUID()}`)
  let committed = false
  try {
    mkdirSync(dirname(outputZipPath), { recursive: true })
    writeFileSync(candidatePath, zipBuffer)
    renameSync(candidatePath, outputZipPath)
    committed = true
  } catch (error) {
    throw new PluginSignError({
      code: 'FH2_SIGN_OUTPUT_WRITE_FAILED',
      message: `写出签名包失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    if (!committed && existsSync(candidatePath)) rmSync(candidatePath, { force: true })
  }
  return { zipPath: outputZipPath, sha256, entryCount: files.size }
}
