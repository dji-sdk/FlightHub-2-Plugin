// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * MCP 客户端配置指南（v3.9 §3）：`--help` 与 TTY 手工启动时输出。
 *
 * - 双形式自适应：调用来自已安装的 `fh2-plugin` 命令（npm 全局 bin 的 symlink，
 *   basename 无扩展名，含 npm link / pnpm link）时主推 `["fh2-plugin","mcp"]`；
 *   仓内直跑 `fh2-plugin.mjs` 时主推「绝对 Node + 绝对 bin」。
 * - 备选段恒定保留绝对路径形式：GUI 客户端（非终端启动）PATH 常不含 npm 全局
 *   bin / nvm node，shebang `#!/usr/bin/env node` 会失败。
 * - JSON 片段经 JSON.stringify 生成（路径含空格自动转义）。
 * - 只写 stdout（--help）或 stderr（ready 后，TTY 判定由调用方负责）。
 */

export interface GuideInput {
  /** installed：调用自全局命令（fh2-plugin，bin symlink）；dev：仓内直跑（fh2-plugin.mjs）。 */
  readonly form: 'installed' | 'dev';
  /** 绝对 node 路径（备选段）。 */
  readonly nodePath: string;
  /** 绝对 bin 路径（备选段；已 realpath）。 */
  readonly binPath: string;
}

export function formatClientConfigGuide (input: GuideInput): string {
  const useSimpleCommand = input.form === 'installed'

  const opencodeMcp = useSimpleCommand
    ? JSON.stringify({
        mcp: {
          fh2: {
            type: 'local',
            command: ['fh2-plugin', 'mcp'],
            enabled: true,
          },
        },
      }, null, 2)
    : JSON.stringify({
        mcp: {
          fh2: {
            type: 'local',
            command: [input.nodePath, input.binPath, 'mcp'],
            enabled: true,
          },
        },
      }, null, 2)

  const claudeCommandLine = useSimpleCommand
    ? 'claude mcp add fh2 -- fh2-plugin mcp'
    : `claude mcp add fh2 -- ${input.nodePath} ${input.binPath} mcp`

  const claudeJson = useSimpleCommand
    ? JSON.stringify({
        mcpServers: {
          fh2: {
            type: 'stdio',
            command: 'fh2-plugin',
            args: ['mcp'],
          },
        },
      }, null, 2)
    : JSON.stringify({
        mcpServers: {
          fh2: {
            type: 'stdio',
            command: input.nodePath,
            args: [input.binPath, 'mcp'],
          },
        },
      }, null, 2)

  const preamble = useSimpleCommand
    ? '把 MCP 配到 AI 客户端（已检测到全局 fh2-plugin 命令，直接用命令名）：'
    : '把 MCP 配到 AI 客户端（当前为仓内直跑形态，command 用绝对路径）：'

  const fallback = [
    '',
    '备选：客户端解析不到 fh2-plugin（GUI 应用常见）或未全局安装时，',
    'command 改用绝对路径形式：',
    `  OpenCode:  ["command", "array"] = ${JSON.stringify([input.nodePath, input.binPath, 'mcp'])}`,
    `  Claude:    command=${JSON.stringify(input.nodePath)}  args=${JSON.stringify([input.binPath, 'mcp'])}`,
  ]

  return [
    preamble,
    '',
    '▸ OpenCode（项目或全局 opencode.json）：',
    opencodeMcp,
    '',
    '▸ Claude Code（二选一）：',
    `  ${claudeCommandLine}`,
    '  或写入 .mcp.json：',
    claudeJson,
    ...fallback,
    '',
    '说明：默认开放模式无需配置 cwd / --root，任意目录的工程都能操作；',
    '需要把可访问路径收纳在指定目录时，在 command 末尾追加 --root <绝对路径>。',
  ].join('\n')
}
