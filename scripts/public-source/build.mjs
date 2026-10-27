#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assetError } from '../../packages/fh2-plugin-toolchain/scripts/copy-workbench.mjs'
import { checkSource, parseSourceArguments, reportSourceError, sourcePaths } from './check.mjs'

export function runSourceCommand (command, args, { cwd, env = process.env, spawn = spawnSync, stdout = process.stdout, capture = false, platform = process.platform } = {}) {
  stdout.write(`[fh2-source] ${[command, ...args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(' ')}\n`)
  // Windows 的 pnpm/npm 只有 .cmd/.ps1 shim（无 .exe），CreateProcess 解析不到；
  // shell:true 经 cmd.exe 按 PATHEXT 解析。POSIX 保持 shell:false 行为不变。
  const shell = platform === 'win32'
  // shell:true 时 Node 同样不会给 command 加引号；Node 安装在含空格路径
  // （如 Windows 默认 C:\Program Files\nodejs）时必须自行包裹，否则 cmd 在空格处截断。
  const commandArgs = shell ? [quoteWindowsArg(command), ...args.map(quoteWindowsArg)] : [command, ...args]
  const result = spawn(commandArgs[0], commandArgs.slice(1), { cwd, env, shell, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' })
  if (result.error) {
    throw assetError('FH2_SOURCE_COMMAND', result.error.code === 'ENOENT'
      ? `${command} 不可用；请检查 PATH 并使用固定版本的 Node/pnpm/npm。`
      : `${command} 无法启动；请检查执行权限。`)
  }
  if (result.status !== 0) {
    throw Object.assign(assetError('FH2_SOURCE_COMMAND', `${command} 执行失败${result.signal ? `（${result.signal}）` : ''}；后续步骤未执行。`), { exitCode: result.status ?? 1 })
  }
  return result
}

/** shell:true 下 Node 不替参数加引号，含空白/引号的 token 必须自行包裹（cmd 的 "" 转义）。 */
export function quoteWindowsArg (value) {
  return /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function buildSource ({ sourceRoot, env = process.env, spawn = spawnSync, stdout = process.stdout } = {}) {
  const paths = sourcePaths(sourceRoot)
  checkSource({ sourceRoot: paths.sourceRoot })
  const options = { cwd: paths.sourceRoot, env, spawn, stdout }
  for (const [name, script] of [
    ['fh2-plugin-sdk', 'build'],
    ['fh2-plugin-toolchain', 'build:dist'],
    ['fh2-plugin-toolchain', 'build:ide'],
  ]) {
    runSourceCommand('pnpm', ['--filter', name, '--fail-if-no-match', 'run', script], options)
  }
  runSourceCommand(process.execPath, [join(paths.packageRoot, 'scripts/copy-workbench.mjs')], options)
  stdout.write('SDK、Toolchain、Web IDE 构建及包内 Mock Host 资源装配完成。\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseSourceArguments(process.argv.slice(2))
    if (args.help) process.stdout.write('用法：node scripts/public-source/build.mjs [--root <源码根>]\n使用 PATH 中的 pnpm，依次构建 SDK、Toolchain dist、IDE，再从固定包内输入装配 Mock Host。\n')
    else buildSource({ sourceRoot: args.root })
  } catch (error) {
    process.exitCode = reportSourceError(error)
  }
}
