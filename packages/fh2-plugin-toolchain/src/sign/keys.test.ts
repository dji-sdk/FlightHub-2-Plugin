// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginSignError } from './signature.js'
import { PRIVATE_KEY_ENV_NAME, PUBLIC_KEY_ENV_NAME, loadSigningKeys } from './keys.js'

function generateKeyPair (): { readonly privateKey: Buffer; readonly publicKey: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' })
  const seed = pkcs8.subarray(pkcs8.byteLength - 32)
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  return {
    privateKey: Buffer.concat([seed, spki.subarray(spki.byteLength - 32)]),
    publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)),
  }
}

const temporaryDirectories: string[] = []

function temporaryFile (name: string, content: Buffer | string): string {
  const directory = mkdtempSync(join(tmpdir(), 'fh2-sign-keys-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('loadSigningKeys', () => {
  it('base64 字符串形态：私钥 64 字节、公钥 32 字节解码成功', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const keys = loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: privateKey.toString('base64'),
      [PUBLIC_KEY_ENV_NAME]: publicKey.toString('base64'),
    })
    expect(keys.privateKey.equals(privateKey)).toBe(true)
    expect(keys.publicKey.equals(publicKey)).toBe(true)
  })

  it('文件路径形态：原始字节密钥文件（本地密钥文件 / CI File 变量）', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const privPath = temporaryFile('key.priv', privateKey)
    const pubPath = temporaryFile('key.pub', publicKey)
    const keys = loadSigningKeys({ [PRIVATE_KEY_ENV_NAME]: privPath, [PUBLIC_KEY_ENV_NAME]: pubPath })
    expect(keys.privateKey.equals(privateKey)).toBe(true)
    expect(keys.publicKey.equals(publicKey)).toBe(true)
  })

  it('文件路径形态：文件内容是带换行的 base64（openssl base64 默认换行 / File 变量填了 base64 文本）', () => {
    const { privateKey, publicKey } = generateKeyPair()
    const privPath = temporaryFile('key.priv.b64', `${privateKey.toString('base64')}\n`)
    const pubPath = temporaryFile('key.pub.b64', publicKey.toString('base64'))
    const keys = loadSigningKeys({ [PRIVATE_KEY_ENV_NAME]: privPath, [PUBLIC_KEY_ENV_NAME]: pubPath })
    expect(keys.privateKey.equals(privateKey)).toBe(true)
    expect(keys.publicKey.equals(publicKey)).toBe(true)
  })

  it('base64 长度错误：硬失败并指明变量名与实际长度（不回显值）', () => {
    expect(() => loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
      [PUBLIC_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
    })).toThrowError(PluginSignError)
    expect(() => loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
      [PUBLIC_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
    })).toThrowError(/FH2_PLUGIN_SIGN_PRIVATE_KEY 的 base64 解码后为 32 字节，期望 64 字节/)
  })

  it('密钥文件长度错误：硬失败（绝不把长度非法字节喂给签名）', () => {
    const badPath = temporaryFile('bad.priv', Buffer.alloc(10))
    expect(() => loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: badPath,
      [PUBLIC_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
    })).toThrowError(/既不是原始 64 字节私钥/)
  })

  it('变量未设置：报错并提示变量名', () => {
    expect(() => loadSigningKeys({})).toThrowError(/FH2_PLUGIN_SIGN_PRIVATE_KEY 未设置/)
    expect(() => loadSigningKeys({ [PRIVATE_KEY_ENV_NAME]: Buffer.alloc(64).toString('base64') }))
      .toThrowError(/FH2_PLUGIN_SIGN_PUBLIC_KEY 未设置/)
  })

  it('值既不是存在文件路径也不是合法 base64：报错', () => {
    expect(() => loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: '/definitely/not/a/file.priv',
      [PUBLIC_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
    })).toThrowError(/既不是已存在文件的路径，也不是合法的单行 base64/)
  })

  it('urlsafe base64（- _ 字母表）不被接受', () => {
    // 确定性构造：64 字节 0xFF 的标准 base64 必然含 /，转 urlsafe 后必然含 _。
    // 不能用随机密钥——约 8% 概率其 base64 不含 + /，urlsafe 与标准编码是同一
    // 字符串、本就是合法标准 base64（此时被接受是正确行为），用例会偶发落空。
    const standard = Buffer.alloc(64, 0xFF).toString('base64')
    const urlsafe = standard.replaceAll('+', '-').replaceAll('/', '_')
    expect(standard).toMatch(/\//)
    expect(urlsafe).toMatch(/_/)
    expect(() => loadSigningKeys({
      [PRIVATE_KEY_ENV_NAME]: urlsafe,
      [PUBLIC_KEY_ENV_NAME]: Buffer.alloc(32).toString('base64'),
    })).toThrowError(PluginSignError)
  })
})
