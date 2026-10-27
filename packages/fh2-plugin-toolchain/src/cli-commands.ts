// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
export interface CliCommand {
  readonly name: string;
  readonly summary: string;
}

/**
 * `fh2-plugin` 子命令。
 *
 * 基础命令来自 Toolchain 设计；`pack` 是服务端包管理对齐后的独立包装层。
 * `mcp` 是 stdio Server 入口（默认开放模式，显式 `--root` 开启收纳边界）。
 * `dev` 最初是**文档缺口**：developer-guide:145 说
 * 「脚手架生成的项目自带 Mock Host Dev Server，命令与参数详见 toolchain 文档」，
 * 但 toolchain §9 只给了编程式 `mockEngine.createPluginHost()` API，
 * 从未定义命令名。此处定为 `fh2-plugin dev`，需在实现批次回写设计文档。
 */
export const CLI_COMMANDS: readonly CliCommand[] = [
  { name: 'create', summary: '创建 Capability 工程或 legacy 单插件工程' },
  { name: 'validate', summary: '校验能力或前后端插件源码清单（后端使用 --root；--manifest 仅用于前端）' },
  { name: 'generate', summary: '为 Capability 前端或单插件生成类型' },
  { name: 'types', summary: '为后端插件生成 ambient 类型声明（types/，按调用形态分世界）' },
  { name: 'build', summary: '构建行业 Capability 工作区、Capability 或插件产物到 dist/' },
  { name: 'pack', summary: '生成未签名行业 Capability 工作区/Capability 上传包；兼容行业包 plugins/* 聚合' },
  { name: 'sign', summary: '对 pack 产物目录生成官方签名安装包 zip（密钥经环境变量注入）' },
  { name: 'dev', summary: '构建插件并启动本地 Mock Host Dev Server（默认持续监听）' },
  { name: 'preview', summary: '构建前端并在真实司空中受控预览本地插件' },
  { name: 'knowledge', summary: '安装/固定后端插件知识包（平台契约事实源：import / use / status）' },
  { name: 'serve', summary: '在 127.0.0.1 启动 Web IDE（前端 + 本地能力层 API）' },
  { name: 'mcp', summary: '启动本地 stdio MCP Server（AI 客户端接入，默认开放；--root 开启收纳模式）' },
]
