// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ApplicationServiceHost } from '../services/tasks/service-host.js'
import type { KnowledgeService } from './knowledge/service.js'
import { CONTRACT_INDEX_URI, CONTRACT_META_URI, KNOWLEDGE_INDEX_URI, knowledgeResourceUri } from './knowledge/repository.js'
import { McpGuardError, type WorkspaceAccess, resolveGuardedPath } from './guard.js'

/**
 * MCP stdio Server：9 个工程工具 + 3 个知识工具 + 契约 Resources。
 *
 * - 所有工具使用 `{ok,data}` / `{ok,error}` 结果信封；structuredContent 与 JSON 文本
 *   content 双写（SDK 1.30 不自动补文本块——C0b 冻结的适配模式）；
 * - Build/Pack/start_dev 在任务受理后返回 taskId，不等待终态；
 *   get_task/cancel_task 使用同一 TaskService，不可越 owner 访问；
 * - Workspace Guard 对所有 path 入参执行边界校验；
 * - 知识查询使用 search_knowledge；只读正文/机器事实以 Resources 为主，
 *   read_contract 是客户端尚未完整支持 Resources 时的兼容入口；
 * - stdout 只承载 MCP 协议帧。
 */

export interface McpServerOptions {
  /** 工作区访问模式（v3.9 §3）：open = 任意路径（默认），contained = --root 边界。 */
  readonly access: WorkspaceAccess;
  readonly version?: string;
  readonly host?: ApplicationServiceHost;
  /** 知识层；缺省时不注册知识工具与 Resources（单测形态）。 */
  readonly knowledge?: KnowledgeService;
}

const TOOL_DESCRIPTIONS = {
  inspect: '检查 FH2 插件工程：识别 Capability / 行业工作区 / 前端 / 后端插件及其成员。',
  validate: '校验工程（含行业工作区 fan-out），返回结构化诊断。',
  generate: '生成前端 plugin-types.ts 与后端 types/；check=true 只检查不写文件。',
  create: '创建新插件工程（同步只生成文件，不安装依赖）；directory 是目标目录。',
  build: '启动 Build 任务（含 Typecheck 门禁），立即返回 taskId。',
  pack: '启动 Pack 任务（Typecheck 门禁 + 确定性 zip），立即返回 taskId。',
  start_dev: '启动本地 Dev 任务（长任务），立即返回 taskId。',
  get_task: '查询任务快照（状态、诊断、产物、日志 sequence）。',
  cancel_task: '取消任务（queued 直接取消；running 停止执行并等待清理）。',
} as const

export function createFh2McpServer (options: McpServerOptions): McpServer {
  const access = options.access
  const host = options.host
  const server = new McpServer({ name: 'fh2-plugin-toolchain', version: options.version ?? '0.0.0' })

  const guardedRoot = (rawPath: unknown): string => resolveGuardedPath(access, rawPath).absolutePath
  /** 工具 path 语义（双模式）：开放 = 相对启动目录/任意绝对路径；收纳 = 相对 root/root 内绝对路径。 */
  const pathHint = access.mode === 'open'
    ? '绝对路径或相对 MCP 启动目录的路径（默认启动目录）'
    : '相对 allowed root 的路径（root 内绝对路径放行，默认根自身）'

  const envelope = (data: unknown) => ({ ok: true as const, data })
  const failure = (code: string, message: string) => ({ ok: false as const, error: { code, message } })

  /** 统一异步捕获：宿主可能同步（in-process）或异步（worker），业务错误映射进信封。 */
  async function callService (operation: () => unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }> {
    try {
      return envelope(await operation())
    } catch (error) {
      if (error instanceof McpGuardError) return failure(error.code, error.message)
      if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
        return failure(String((error as { code: unknown }).code), error.message)
      }
      return failure('FH2_MCP_INTERNAL', error instanceof Error ? error.message : String(error))
    }
  }

  async function callTask (operation: () => Promise<unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }> {
    try {
      return envelope(await operation())
    } catch (error) {
      if (error instanceof McpGuardError) return failure(error.code, error.message)
      const code = error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
        ? String((error as { code: unknown }).code)
        : 'FH2_MCP_INTERNAL'
      return failure(code, error instanceof Error ? error.message : String(error))
    }
  }

  // 同步工具不需要 host 时（纯 guard 测试）也不应崩溃：host 为空时报服务不可用。
  const requireHost = (): ApplicationServiceHost => {
    if (host === undefined) throw new Error('MCP 服务宿主不可用。Service host unavailable.')
    return host
  }

  registerTool(server, 'inspect', {
    description: TOOL_DESCRIPTIONS.inspect,
    inputSchema: { path: z.string().optional().describe(pathHint) },
  }, async ({ path }) => {
    return toResult(await callService(() => requireHost().inspect(guardedRoot(path))))
  })

  registerTool(server, 'validate', {
    description: TOOL_DESCRIPTIONS.validate,
    inputSchema: { path: z.string().optional() },
  }, async ({ path }) => {
    return toResult(await callService(() => requireHost().validate(guardedRoot(path))))
  })

  registerTool(server, 'generate', {
    description: TOOL_DESCRIPTIONS.generate,
    inputSchema: { path: z.string().optional(), check: z.boolean().optional() },
  }, async ({ path, check }) => {
    return toResult(await callService(() => requireHost().generate(guardedRoot(path), check === true)))
  })

  registerTool(server, 'create', {
    description: TOOL_DESCRIPTIONS.create,
    inputSchema: {
      pluginId: z.string().describe('插件 ID（official_/exp_ 前缀小写短名）'),
      directory: z.string().optional().describe(`${pathHint}；目标目录可不存在（创建时生成）`),
      template: z.enum(['capability-fullstack', 'frontend-basic', 'backend-basic']).optional(),
    },
  }, async ({ pluginId, directory, template }) => {
    return toResult(await callTask(async () => {
      // create 的基目录：开放模式 = 启动 cwd（directory 可为任意绝对路径）；
      // 收纳模式 = 冻结 root（directory 相对 root 或 root 内绝对路径）。
      const createBase = access.mode === 'open' ? access.baseDir : access.root
      const resolvedDirectory = directory === undefined ? undefined : guardedRoot(directory)
      return await requireHost().create(createBase, {
        pluginId,
        ...(resolvedDirectory === undefined ? {} : { directory: resolvedDirectory }),
        ...(template === undefined ? {} : { template }),
      })
    }))
  })

  registerTool(server, 'build', {
    description: TOOL_DESCRIPTIONS.build,
    inputSchema: {
      path: z.string().optional(),
      mode: z.enum(['development', 'production']).optional(),
    },
  }, async ({ path, mode }) => {
    // 受理不等待终态（§3.1）：返回 taskId。
    return toResult(await callTask(() => requireHost().taskStart('build', guardedRoot(path), mode === undefined ? {} : { mode })))
  })

  registerTool(server, 'pack', {
    description: TOOL_DESCRIPTIONS.pack,
    inputSchema: {
      path: z.string().optional(),
      noBuild: z.boolean().optional(),
    },
  }, async ({ path, noBuild }) => {
    return toResult(await callTask(() => requireHost().taskStart('pack', guardedRoot(path), noBuild === true ? { noBuild: true } : {})))
  })

  registerTool(server, 'start_dev', {
    description: TOOL_DESCRIPTIONS.start_dev,
    inputSchema: {
      path: z.string().optional(),
      port: z.number().int().optional(),
    },
  }, async ({ path, port }) => {
    return toResult(await callTask(() => requireHost().taskStart('dev', guardedRoot(path), port === undefined ? {} : { port })))
  })

  registerTool(server, 'get_task', {
    description: TOOL_DESCRIPTIONS.get_task,
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => toResult(await callTask(() => requireHost().taskGet(taskId))))

  registerTool(server, 'cancel_task', {
    description: TOOL_DESCRIPTIONS.cancel_task,
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => toResult(await callTask(() => requireHost().taskCancel(taskId))))

  registerKnowledge(server, options, callService)

  return server
}

/** 知识 Tools + Resources：in-process 只读公共运行投影，不走 worker、不触碰 workspace root。 */
function registerKnowledge (
  server: McpServer,
  options: McpServerOptions,
  callService: (operation: () => unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }>,
): void {
  const knowledge = options.knowledge
  if (knowledge === undefined) return

  const requireKnowledge = (): KnowledgeService => {
    if (knowledge === undefined) throw new Error('MCP 知识层不可用。Knowledge service unavailable.')
    return knowledge
  }

  const versionsBlock = () => ({
    toolchain: options.version ?? '0.0.0',
    contract: knowledge.versions.contract,
    contractsVersion: knowledge.versions.contractsVersion,
    knowledgeStatus: knowledge.versions.knowledgeStatus,
    contractStatus: knowledge.versions.contractStatus,
    approvedEntries: knowledge.versions.approvedEntries,
    contractDigest: knowledge.versions.contractDigest,
    bundleDigest: knowledge.versions.bundleDigest,
    projection: knowledge.repository.bundle.projection,
  })
  const taxonomyDescription = Object.entries(knowledge.kindsByDomain)
    .map(([domain, kinds]) => `${domain}: ${kinds.join('/')}`)
    .join('；')

  registerContractResources(server, knowledge)

  registerTool(server, 'list_knowledge', {
    description: `结构化列举 FH2 插件平台知识。用户问“有哪些能力/扩展点/命令/触发器/错误码”时应使用本工具，不要用全文搜索。合法 domain/kind 组合：${taxonomyDescription}。`,
    inputSchema: {
      domain: z.string().optional().describe(`按域过滤；当前可用：${knowledge.domains.join('/')}`),
      kind: z.string().optional().describe(`按知识类别过滤；与 domain 同传时必须符合：${taxonomyDescription}`),
      offset: z.number().int().min(0).optional().describe('分页偏移，默认 0'),
      limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 50，最大 100'),
    },
  }, async ({ domain, kind, offset, limit }) => {
    const envelope = await callService(() => ({ ...requireKnowledge().list({ domain, kind, offset, limit }), versions: versionsBlock() }))
    return toKnowledgeLinksResult(envelope)
  })

  registerTool(server, 'search_knowledge', {
    description: `按中文语义或标识符查找相关 FH2 插件平台知识（当前 ${knowledge.size} 条，domain/kind 来自契约索引），返回摘要以及知识正文、机器事实的 MCP Resource URI。合法 domain/kind 组合：${taxonomyDescription}。枚举“有哪些”时改用 list_knowledge。`,
    inputSchema: {
      query: z.string().min(1).max(500).describe('检索词：中文语义（如「插件缓存」）或标识符（如 cache:read / cockpit.ui.flight-actions）'),
      domain: z.string().optional().describe(`按域过滤；当前可用：${knowledge.domains.join('/')}`),
      kind: z.string().optional().describe(`按知识类别过滤；与 domain 同传时必须符合：${taxonomyDescription}`),
      limit: z.number().int().min(1).max(10).optional().describe('返回条数上限，默认 5'),
    },
  }, async ({ query, domain, kind, limit }) => {
    const envelope = await callService(() => {
      const result = requireKnowledge().search({ query, domain, kind, limit })
      return { items: result.items, total: result.total, versions: versionsBlock() }
    })
    return toKnowledgeLinksResult(envelope)
  })

  registerTool(server, 'read_contract', {
    description: '兼容性读取入口：按 targetId、已发布的 JSON 文件别名、evidence factRef 或 fh2-contract:// Resource URI 读取只读契约，不读取未发布文件。支持 Resources 的客户端应优先直接读取 search_knowledge 返回的 URI。',
    inputSchema: {
      ref: z.string().min(1).max(1000).describe('如 tooling.command.build、tooling/cli-commands.json#commands/build 或 fh2-contract://knowledge/tooling.command.build'),
    },
  }, async ({ ref }) => {
    return toResult(await callService(() => ({ ...requireKnowledge().readContract(ref), versions: versionsBlock() })))
  })
}

function registerContractResources (server: McpServer, knowledge: KnowledgeService): void {
  const repository = knowledge.repository
  const json = (uri: string, value: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }] })

  server.registerResource('fh2-contract-meta', CONTRACT_META_URI, {
    title: 'FH2 契约元数据',
    description: '来源契约版本、摘要、公共投影指纹及 domain/kind 归属关系。',
    mimeType: 'application/json',
  }, async () => json(CONTRACT_META_URI, {
    ...knowledge.versions,
    projection: repository.bundle.projection,
    domains: knowledge.domains,
    kinds: knowledge.kinds,
    kindsByDomain: knowledge.kindsByDomain,
  }))
  server.registerResource('fh2-contract-index', CONTRACT_INDEX_URI, {
    title: 'FH2 契约根索引',
    description: '契约包全部公开文档的路径索引。',
    mimeType: 'application/json',
  }, async () => json(CONTRACT_INDEX_URI, repository.readFile(repository.bundle.rootIndexPath).value))
  server.registerResource('fh2-knowledge-index', KNOWLEDGE_INDEX_URI, {
    title: 'FH2 全局知识索引',
    description: 'targetId 到知识分片与机器事实引用的路由。',
    mimeType: 'application/json',
  }, async () => json(KNOWLEDGE_INDEX_URI, repository.readFile(repository.bundle.knowledgeIndexPath).value))

  server.registerResource('fh2-knowledge', new ResourceTemplate('fh2-contract://knowledge/{targetId}', {
    list: async () => ({ resources: repository.entries.map(entry => ({
      uri: knowledgeResourceUri(entry.targetId),
      name: entry.targetId,
      title: entry.content.summary.slice(0, 80),
      description: `${entry.domain}/${entry.kind}`,
      mimeType: 'application/json',
    })) }),
    complete: { targetId: value => repository.entries.map(entry => entry.targetId).filter(id => id.includes(value)).slice(0, 50) },
  }), { title: 'FH2 知识正文', description: '按 targetId 读取完整中文开发知识。', mimeType: 'application/json' }, async (uri, variables) => {
    const targetId = decodeURIComponent(String(variables.targetId))
    return json(uri.href, repository.readKnowledge(targetId))
  })

  server.registerResource('fh2-fact', new ResourceTemplate('fh2-contract://fact/{encodedRef}', { list: undefined }), {
    title: 'FH2 机器事实',
    description: '读取 search_knowledge 返回的 factResourceUri；encodedRef 是 evidence factRef 的 base64url。',
    mimeType: 'application/json',
  }, async (uri, variables) => {
    const factRef = Buffer.from(decodeURIComponent(String(variables.encodedRef)), 'base64url').toString()
    return json(uri.href, repository.readFact(factRef))
  })
}

/** 同一 shape 驱动 SDK 校验与未知键提示；业务回调只消费其已定义参数。 */
function registerTool<Shape extends z.ZodRawShape> (
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Shape },
  callback: (args: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult>,
): void {
  server.registerTool(name, { ...config, inputSchema: z.object(config.inputSchema).passthrough() }, async (args) => {
    // 提示只保留键名且属于本次请求，不能回显值或跨异步请求共享状态。
    const ignoredArguments = Object.keys(args).filter(key => !Object.prototype.hasOwnProperty.call(config.inputSchema, key)).sort()
    const result = await callback(args)
    if (ignoredArguments.length === 0) return result
    const message = `已忽略未知参数：${ignoredArguments.join('、')}。这些参数不会转发给 CLI 或服务；工具仍按已定义参数及默认值执行，忽略参数不代表只读。`
    const structuredContent = { ...result.structuredContent, warnings: [{ message, ignoredArguments }] }
    return {
      ...result,
      structuredContent,
      content: [
        { type: 'text', text: JSON.stringify(structuredContent) },
        ...result.content.slice(1),
        { type: 'text', text: message },
      ],
    }
  })
}

function toKnowledgeLinksResult (envelope: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }): CallToolResult {
  const base = toResult(envelope)
  if (!envelope.ok) return base
  const data = envelope.data as { items?: Array<{ targetId: string; summary: string; resourceUri: string }> }
  return {
    ...base,
    content: [
      ...base.content,
      ...(data.items ?? []).map(item => ({
        type: 'resource_link' as const,
        uri: item.resourceUri,
        name: item.targetId,
        title: item.summary.slice(0, 80),
        description: 'FH2 插件平台知识正文',
        mimeType: 'application/json',
      })),
    ],
  }
}

/** 结果信封 → MCP CallToolResult：structuredContent + 兼容 JSON 文本双写。 */
function toResult (envelope: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }): CallToolResult {
  const isError = !envelope.ok
  const result: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  }
  if (isError) result.isError = true
  return result
}
