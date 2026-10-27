// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { cliDefinition, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { loadSigningKeys } from '../sign/keys.js'
import { PluginSignError, signPluginPackage } from '../sign/index.js'
import { CliArgumentError, parseCommandArguments } from './arguments.js'
import type { CommandWriter } from './validate-command.js'

const DEFINITION = cliDefinition('sign')
export const SIGN_HELP = `用法：fh2-plugin sign [选项]

对 pack 产物目录生成官方签名安装包 zip（ed25519 签名 + 顶层 SIGNATURE 条目）。
产物是确定性 zip：同素材 + 同私钥 + 同 keyId 两次签名逐字节相同，zip 的
sha256 即素材指纹。

密钥只经环境变量注入（不进命令行参数、源码或配置文件），两种值形态按
「值是否命中已存在的文件路径」自动判定：
  FH2_PLUGIN_SIGN_PRIVATE_KEY   私钥：64 字节原始内容或其 base64（单行），
                                或密钥文件路径（CI File 类型变量）
  FH2_PLUGIN_SIGN_PUBLIC_KEY    公钥：32 字节原始内容或其 base64（单行），
                                或公钥文件路径
  FH2_PLUGIN_SIGN_KEY_ID        可选，写入 SIGNATURE.keyId 的留痕标识；
                                --keyid 参数优先于该变量
签名后立即用公钥自检配对，公私钥不是一对时直接失败、不产出 zip。

${renderCliOptions(DEFINITION)}`
export const SIGN_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: [],
  exitCodes: [{ code: 0, meaning: '签名打包成功' }, { code: 1, meaning: '签名失败（密钥缺失/无效、公私钥不配对或产物目录非法）' }, { code: 2, meaning: '参数错误（--in 与 --out 必填）' }, { code: 3, meaning: '内部错误' }],
  notes: ['不依赖工程上下文：对 pack 产物目录执行，密钥只经环境变量注入（FH2_PLUGIN_SIGN_PRIVATE_KEY / FH2_PLUGIN_SIGN_PUBLIC_KEY）', '产物是确定性 zip：同素材 + 同私钥 + 同 keyId 逐字节相同；签名后立即用公钥自检配对，不配对不产出'],
  source: 'src/commands/sign-command.ts#runSignCommand',
}

export interface SignCommandOptions {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: CommandWriter;
  readonly stderr: CommandWriter;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export async function runSignCommand (options: SignCommandOptions): Promise<number> {
  try {
    const parsed = parseCommandArguments(options.args, DEFINITION)
    if (parsed.flag('help')) {
      options.stdout.write(SIGN_HELP)
      return 0
    }
    if (parsed.values.in === undefined || parsed.values.out === undefined) {
      const missing = [
        ...(parsed.values.in === undefined ? ['--in'] : []),
        ...(parsed.values.out === undefined ? ['--out'] : []),
      ]
      throw new CliArgumentError(`缺少必填参数：${missing.join('、')}`)
    }

    const keys = loadSigningKeys(options.env)
    const result = await signPluginPackage({
      inputRoot: resolve(options.cwd, parsed.values.in),
      outputZipPath: resolve(options.cwd, parsed.values.out),
      keyId: parsed.value('keyid', { env: options.env })!,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    })
    options.stdout.write(`✓ 已签名打包: ${result.zipPath}（${result.entryCount} 个文件,含 SIGNATURE）\n`)
    options.stdout.write(`SHA256 ${result.sha256}\n`)
    return 0
  } catch (error) {
    if (error instanceof CliArgumentError) {
      options.stderr.write(`${error.message}\n\n${SIGN_HELP}`)
      return 2
    }
    if (error instanceof PluginSignError) {
      options.stderr.write(`${error.diagnostic.code} [sign] ${error.diagnostic.message}\n`)
      return 1
    }
    options.stderr.write(`[fh2-plugin] sign 内部错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }
}
