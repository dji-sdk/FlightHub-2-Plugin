// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { PluginSignError } from './signature.js'

/**
 * 签名密钥只经环境变量注入（密钥红线：不进源码、命令行参数、配置文件）。
 *
 * 两个变量都支持两种值形态，按「值是否命中一个已存在的文件路径」自动判定：
 * 1. 文件路径——本地密钥文件或 CI File 类型变量（GitLab 把值写进临时文件、
 *    变量值为路径）。文件内容要求原始字节（私钥 64 / 公钥 32）；也接受
 *    带换行的 base64 文本（`openssl base64` 默认 64 字符换行 / 用户把 base64
 *    字符串填进了 File 变量）。
 * 2. base64 字符串——CI Variable 类型变量直接填单行 base64。
 *
 * 长度校验是硬失败：绝不把长度非法的字节喂给签名/验签（错误信息只报
 * 长度与形态，绝不回显变量值——密钥红线）。
 */

export const PRIVATE_KEY_ENV_NAME = 'FH2_PLUGIN_SIGN_PRIVATE_KEY'
export const PUBLIC_KEY_ENV_NAME = 'FH2_PLUGIN_SIGN_PUBLIC_KEY'
export const KEY_ID_ENV_NAME = 'FH2_PLUGIN_SIGN_KEY_ID'

export interface SigningKeys {
  /** 64 字节原始 ed25519 私钥（seed + 公钥） */
  readonly privateKey: Buffer;
  /** 32 字节原始 ed25519 公钥 */
  readonly publicKey: Buffer;
}

export const PRIVATE_KEY_BYTES = 64
export const PUBLIC_KEY_BYTES = 32

export function loadSigningKeys (env: Readonly<Record<string, string | undefined>>): SigningKeys {
  const privateKey = loadKeyBytes(env, PRIVATE_KEY_ENV_NAME, PRIVATE_KEY_BYTES, '私钥')
  const publicKey = loadKeyBytes(env, PUBLIC_KEY_ENV_NAME, PUBLIC_KEY_BYTES, '公钥')
  return { privateKey, publicKey }
}

function loadKeyBytes (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  expectedBytes: number,
  label: string,
): Buffer {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new PluginSignError({
      code: 'FH2_SIGN_KEY_ENV_MISSING',
      message: `环境变量 ${name} 未设置（${label}只经环境变量注入，支持文件路径或 base64 值两种形态）`,
    })
  }
  // 形态一：已存在的文件路径（本地密钥文件 / CI File 类型变量）。
  if (existsSync(value)) {
    const content = readFileSync(value)
    if (content.byteLength === expectedBytes) return content
    // 文件内容是带换行的 base64 文本：剥掉换行后按严格 base64 解码。
    const stripped = content.toString('utf8').replace(/[\r\n]+/g, '')
    if (isStrictBase64(stripped)) {
      const decoded = Buffer.from(stripped, 'base64')
      if (decoded.byteLength === expectedBytes) return decoded
    }
    throw new PluginSignError({
      code: 'FH2_SIGN_KEY_LENGTH',
      message: `${name} 指向的文件为 ${content.byteLength} 字节，既不是原始 ${expectedBytes} 字节${label}，也不是解码后 ${expectedBytes} 字节的 base64 文本`,
    })
  }
  // 形态二：base64 字符串（CI Variable 类型变量）。
  if (isStrictBase64(value)) {
    const decoded = Buffer.from(value, 'base64')
    if (decoded.byteLength !== expectedBytes) {
      throw new PluginSignError({
        code: 'FH2_SIGN_KEY_LENGTH',
        message: `${name} 的 base64 解码后为 ${decoded.byteLength} 字节，期望 ${expectedBytes} 字节${label}`,
      })
    }
    return decoded
  }
  throw new PluginSignError({
    code: 'FH2_SIGN_KEY_ENV_INVALID',
    message: `${name} 的值既不是已存在文件的路径，也不是合法的单行 base64 字符串`,
  })
}

/** 严格 base64：标准字母表（+ /，非 urlsafe）、合法 padding、长度为 4 的倍数。 */
function isStrictBase64 (value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0
}
