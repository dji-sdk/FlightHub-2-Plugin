// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

/**
 * C0b（Wave 0）：官方 MCP SDK 实际 API 验证。
 *
 * 已核实的 SDK 1.30.0 事实（实施计划 C0b 交付）：
 * - `serveStdio` 已从 SDK 移除；stdio 服务方式是 `server.connect(new StdioServerTransport())`；
 * - `registerTool` 的 `inputSchema`/`outputSchema` 只接受 zod（v3/v4），不接受裸 JSON Schema；
 * - 带 `outputSchema` 的工具回包提供 `structuredContent`，SDK 自动补 JSON 文本 `content`；
 * - listTools 广播的 JSON Schema 由 SDK 从 zod 生成。
 */
const PROBE_TOOL = 'probe_echo'

function registerProbeTool (server: McpServer): void {
  server.registerTool(
    PROBE_TOOL,
    {
      description: '回显输入',
      inputSchema: { message: z.string() },
      outputSchema: { message: z.string(), upper: z.string() },
    },
    async ({ message }) => {
      // SDK 1.30 不自动补文本 content，适配层必须显式双写（C0b 冻结的适配模式）。
      const structuredContent = { message, upper: message.toUpperCase() }
      return {
        structuredContent,
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      }
    },
  )
}

async function expectProbeBehavior (client: Client): Promise<void> {
  const tools = await client.listTools()
  const echo = tools.tools.find(tool => tool.name === PROBE_TOOL)
  expect(echo).toBeDefined()
  expect(echo?.inputSchema).toMatchObject({
    type: 'object',
    properties: { message: { type: 'string' } },
  })
  expect(echo?.outputSchema).toMatchObject({
    type: 'object',
    properties: { message: { type: 'string' }, upper: { type: 'string' } },
  })

  const result = await client.callTool({ name: PROBE_TOOL, arguments: { message: '你好 hello' } })
  expect(result.isError).toBeFalsy()
  expect(result.structuredContent).toEqual({ message: '你好 hello', upper: '你好 HELLO' })
  // 兼容客户端：SDK 自动把 structuredContent 序列化为 JSON 文本 content。
  const content = result.content as readonly { readonly type: string; readonly text: string }[]
  expect(JSON.parse(content[0]?.text ?? '')).toEqual({ message: '你好 hello', upper: '你好 HELLO' })

  // 输入校验：缺 message 时是业务可读的 isError 结果，而非协议错误。
  const invalid = await client.callTool({ name: PROBE_TOOL, arguments: {} })
  expect(invalid.isError).toBe(true)
}

describe('mCP SDK C0b 验证', () => {
  it('in-memory：registerTool + listTools + structuredContent/文本兼容', async () => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' })
    registerProbeTool(server)
    const client = new Client({ name: 'probe-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      await expectProbeBehavior(client)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('真实 stdio：spawn 探针 server，初始化并完成工具往返', { timeout: 15_000 }, async () => {
    const serverScript = fileURLToPath(new URL('./fixtures/stdio-probe-server.mjs', import.meta.url))
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(serverScript)] })
    const client = new Client({ name: 'probe-client', version: '0.0.0' })
    await client.connect(transport)
    try {
      await expectProbeBehavior(client)
    } finally {
      await client.close()
    }
  })
})
