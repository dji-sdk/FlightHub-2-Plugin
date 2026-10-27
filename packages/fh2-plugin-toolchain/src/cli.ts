// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { CLI_COMMANDS } from './cli-commands.js'
import { renderRootCliUsage } from './cli-definitions.js'
import { ManifestError, TOOLCHAIN_VERSION } from './manifest.js'

function usage (): string {
  return renderRootCliUsage()
}

async function main (): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage())
    return 0
  }

  if (!CLI_COMMANDS.some(item => item.name === command)) {
    process.stderr.write(`未知命令: ${command}\n\n${usage()}`)
    return 1
  }

  // mcp 是常驻 stdio 进程：跳过版本横幅，保持 stderr 只有协议/worker 日志。
  if (command === 'mcp') {
    const { runMcpMain } = await import('./mcp/main.js')
    return await runMcpMain(rest)
  }

  process.stderr.write(`[fh2-plugin] 当前 ${command} 使用 Toolchain v${TOOLCHAIN_VERSION}\n`)

  // 各命令按需加载：mcp 常驻进程不因 CLI 分发加载 build/serve 等模块。
  if (command === 'create') {
    const { runCreatePlugin } = await import('./create/run.js')
    return await runCreatePlugin({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      enforceDependencySource: true,
    })
  }

  if (command === 'validate') {
    const { runValidateCommand } = await import('./commands/validate-command.js')
    return await runValidateCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    })
  }

  if (command === 'types') {
    const { runTypesCommand } = await import('./commands/types-command.js')
    return runTypesCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    })
  }

  if (command === 'generate') {
    const { runGenerateCommand } = await import('./commands/generate-command.js')
    return runGenerateCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    })
  }

  if (command === 'build') {
    const { runBuildCommand } = await import('./commands/build-command.js')
    return runBuildCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      signals: process,
    })
  }

  if (command === 'pack') {
    const { runPackCommand } = await import('./commands/pack-command.js')
    return runPackCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      signals: process,
    })
  }

  if (command === 'sign') {
    const { runSignCommand } = await import('./commands/sign-command.js')
    return runSignCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    })
  }

  if (command === 'dev') {
    const { runDevCommand } = await import('./commands/dev-command.js')
    return runDevCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      signals: process,
      env: process.env,
      forceExit: code => process.exit(code),
    })
  }

  if (command === 'preview') {
    const { runPreviewCommand } = await import('./commands/preview-command.js')
    return runPreviewCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      signals: process,
      env: process.env,
      forceExit: code => process.exit(code),
      ...(process.stdin.isTTY && process.stdout.isTTY
        ? {
            prompt: async (message: string) => {
              const readline = createInterface({ input: process.stdin, output: process.stdout })
              try {
                return await readline.question(message)
              } finally {
                readline.close()
              }
            },
          }
        : {}),
    })
  }

  if (command === 'knowledge') {
    const { runKnowledgeCommand } = await import('./commands/knowledge-command.js')
    return await runKnowledgeCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
    })
  }

  if (command === 'serve') {
    const { runServeCommand } = await import('./commands/serve-command.js')
    return runServeCommand({
      args: rest,
      cwd: process.cwd(),
      stdout: process.stdout,
      stderr: process.stderr,
      signals: process,
      env: process.env,
      forceExit: code => process.exit(code),
    })
  }

  process.stderr.write(
    `[fh2-plugin] \`${command}\` 尚未实现，见 docs/design/fh2-plugin-toolchain-design.md\n`,
  )
  return 1
}

main().then((exitCode) => {
  process.exitCode = exitCode
}).catch((error: unknown) => {
  if (error instanceof ManifestError) process.stderr.write(`${error.message}\n`)
  else process.stderr.write(`[fh2-plugin] ${(error as Error).message}\n`)
  process.exitCode = 1
})
