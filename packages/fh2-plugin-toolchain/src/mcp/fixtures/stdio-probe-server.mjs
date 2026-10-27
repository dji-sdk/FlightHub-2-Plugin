#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * C0b stdio 探针：最小 MCP Server，注册一个带 inputSchema/outputSchema 的工具，
 * 经 StdioServerTransport 服务。仅用于验证 SDK 实际 API 与 stdio 初始化，
 * 不代表 A12 的生产 Server（那是 M1/M2 的交付）。
 *
 * stdout 只承载 MCP 协议帧；本文件不得向 stdout 打印协议外内容。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fh2-c0b-probe', version: '0.0.0' })

server.registerTool(
  'probe_echo',
  {
    description: '回显输入，验证 inputSchema 校验与 structuredContent/文本兼容',
    inputSchema: { message: z.string() },
    outputSchema: { message: z.string(), upper: z.string() },
  },
  async ({ message }) => {
    // SDK 1.30 不会自动把 structuredContent 序列化为文本 content；
    // 兼容客户端的 JSON 文本块必须由适配层显式双写（C0b 冻结的适配模式）。
    const structuredContent = { message, upper: message.toUpperCase() }
    return {
      structuredContent,
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    }
  },
)

await server.connect(new StdioServerTransport())
