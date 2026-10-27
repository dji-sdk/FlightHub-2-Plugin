// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { dirname, join, relative, resolve, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadDeveloperRuntime } from '../../developer-runtime/loader.js'
import { CAPABILITY_METADATA_SCHEMA, PROJECT_PATHS, manifestSide } from '../../project-policy.js'
import { resolveRuntimeProfile } from '../application/runtime-profile.js'
import type { IdeSchemaEntry, IdeSchemasData } from '../../contracts/ide.js'

/** 清单 Schema 按真实成员身份绑定，前后端同名文件不会互相误诊。 */
const SCHEMA_SOURCES: readonly {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  /** 相对包根的候选路径，按顺序取第一个存在的（monorepo / 发布包两种布局）。 */
  readonly candidates?: readonly string[];
  readonly projection?: 'sourceManifest' | 'workflow';
}[] = [
  {
    uri: 'fh2://schema/manifest',
    fileMatch: [PROJECT_PATHS.sourceManifest],
    candidates: [
      // monorepo：SDK 源码就在隔壁包
      '../fh2-plugin-sdk/src/schema/manifest.schema.json',
      // 发布包：SDK 作为依赖安装，dist 里带 schema
      'node_modules/fh2-plugin-sdk/dist/schema/manifest.schema.json',
      '../../node_modules/fh2-plugin-sdk/dist/schema/manifest.schema.json',
      '../fh2-plugin-sdk/dist/schema/manifest.schema.json',
    ],
  },
  {
    uri: 'fh2://schema/backend-plugin',
    fileMatch: [PROJECT_PATHS.runtimeManifest],
    projection: 'sourceManifest',
  },
  {
    uri: 'fh2://schema/workflow',
    fileMatch: ['workflows/*.json', 'flows/*.json', '*.flow.json'],
    projection: 'workflow',
  },
]

export interface ResolveIdeSchemasOptions {
  /** 覆盖包根探测，仅测试使用。 */
  readonly packageRoot?: string;
  /** Explicit projection fixture root for tests. */
  readonly developerRuntimeRoot?: string;
  readonly root?: string;
}

/**
 * 运行时读取三份真实 Schema 并内联返回。
 *
 * 不用 `import ... with { type: 'json' }`：那样 manifest schema 会被 tsup 内联进
 * dist，与 SDK 实际安装版本脱钩；这里按 dev-command 解析 workbench 的同样思路，
 * 从包布局里现读。
 */
export function resolveIdeSchemas (options: ResolveIdeSchemasOptions = {}): IdeSchemasData {
  const packageRoot = options.packageRoot ?? resolveToolchainPackageRoot()
  const runtime = loadDeveloperRuntime(options.developerRuntimeRoot === undefined ? {} : { root: options.developerRuntimeRoot })
  const schemas: IdeSchemaEntry[] = []
  const profile = options.root ? resolveRuntimeProfile(options.root) : undefined
  const profileMatches = (side: 'frontend' | 'backend'): string[] => (profile?.[side] ?? []).flatMap(project =>
    [PROJECT_PATHS.sourceManifest, ...(side === 'backend' ? [PROJECT_PATHS.runtimeManifest] : [])]
      .filter(name => existsSync(join(project.root, name)))
      .map(name => `${profile!.root.split(sep).join('/')}/${relative(profile!.root, join(project.root, name)).split(sep).join('/')}`))
  const fallbackMatches = options.root === undefined ? undefined : discoverSchemaTargets(options.root)
  const matches = (side: 'frontend' | 'backend'): readonly string[] => {
    const fromProfile = profileMatches(side)
    // marker-only 身份识别会让损坏工程保留正常 kind，但严格 profile 没有成员；
    // 始终合并有限目录扫描，才能在修复期间继续把 Manifest 绑定到正确 Schema。
    return [...new Set([...fromProfile, ...(fallbackMatches?.[side] ?? [])])]
  }
  const capabilityMatches = options.root === undefined
    ? [PROJECT_PATHS.capabilityMetadata]
    : (fallbackMatches?.capability ?? [])
  /**
   * Workflow fileMatch 必须同时服务 Monaco 与画布候选扫描：
   *
   * - Monaco 的 model URI 是绝对 file URI，前导“双星目录”允许匹配工作区绝对前缀；
   * - 画布扫描传入工作区相对路径，同一个双星目录也能匹配零层前缀；
   * - Capability/行业工作区只枚举真实 backend 成员，不能把前端插件里偶然出现的
   *   `workflows/` 当成 Worker Workflow。
   */
  const workflowMatches = (defaults: readonly string[]): string[] => {
    if (profile === undefined || profile.kind === 'unknown') return [...defaults]
    return [...new Set(profile.backend.flatMap((project) => {
      const prefix = relative(profile.root, project.root).split(sep).join('/')
      return defaults.map(pattern => `**/${prefix === '' ? '' : `${prefix}/`}${pattern}`)
    }))]
  }
  for (const source of SCHEMA_SOURCES) {
    let schema: unknown
    if (source.projection !== undefined) {
      schema = runtime.schemas[source.projection]
    } else {
      const file = source.candidates!
        .map(candidate => resolve(packageRoot, candidate))
        .find(candidate => existsSync(candidate))
      if (file === undefined) continue
      try {
        schema = JSON.parse(readFileSync(file, 'utf8')) as unknown
      } catch {
        // The optional SDK schema retains its existing behavior; projection failure is fatal.
        continue
      }
    }
    schemas.push({
      uri: source.uri,
      fileMatch: source.uri === 'fh2://schema/workflow'
        ? workflowMatches(source.fileMatch)
        : profile
          ? matches(source.uri === 'fh2://schema/manifest' ? 'frontend' : 'backend')
          : source.fileMatch,
      schema,
    })
  }
  schemas.push({
    uri: 'fh2://schema/capability-metadata',
    fileMatch: capabilityMatches,
    schema: CAPABILITY_METADATA_SCHEMA,
  })
  return { schemas }
}

interface SchemaTargets {
  readonly frontend: readonly string[];
  readonly backend: readonly string[];
  readonly capability: readonly string[];
}

/**
 * Schema 必须能诊断“正处于损坏状态”的清单，不能依赖严格 discovery 成功后才关联。
 * 这里只按仓库既定目录形态找标志文件，不解析 Capability 元数据，也不递归扫任意目录。
 */
function discoverSchemaTargets (rawRoot: string): SchemaTargets {
  const root = resolve(rawRoot)
  const frontend = new Set<string>()
  const backend = new Set<string>()
  const capability = new Set<string>()
  const addMatch = (set: Set<string>, path: string): void => {
    if (existsSync(path)) set.add(path.split(sep).join('/'))
  }
  const addPluginContainer = (container: string, side: 'frontend' | 'backend'): void => {
    for (const directory of directDirectories(container)) {
      addMatch(side === 'frontend' ? frontend : backend, join(directory, PROJECT_PATHS.sourceManifest))
      if (side === 'backend') addMatch(backend, join(directory, PROJECT_PATHS.runtimeManifest))
    }
  }

  addMatch(capability, join(root, PROJECT_PATHS.capabilityMetadata))
  addPluginContainer(join(root, PROJECT_PATHS.frontend), 'frontend')
  addPluginContainer(join(root, PROJECT_PATHS.backend), 'backend')
  for (const directory of directDirectories(root)) {
    if (!existsSync(join(directory, PROJECT_PATHS.capabilityMetadata))) continue
    addMatch(capability, join(directory, PROJECT_PATHS.capabilityMetadata))
    addPluginContainer(join(directory, PROJECT_PATHS.frontend), 'frontend')
    addPluginContainer(join(directory, PROJECT_PATHS.backend), 'backend')
  }

  const rootManifest = join(root, PROJECT_PATHS.sourceManifest)
  if (existsSync(rootManifest)) {
    const side = readManifestSide(rootManifest)
    addMatch(side === 'frontend' ? frontend : backend, rootManifest)
    if (side === 'backend') addMatch(backend, join(root, PROJECT_PATHS.runtimeManifest))
  }
  return { frontend: [...frontend], backend: [...backend], capability: [...capability] }
}

function directDirectories (root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.') && entry.isDirectory())
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

function readManifestSide (file: string): 'frontend' | 'backend' {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return manifestSide(value as Record<string, unknown>)
    }
  } catch {
    // JSON 语法错误仍由 Monaco 自身诊断；side 沿用 discovery 的 frontend fallback。
  }
  return 'frontend'
}

/** 与 dev-command.resolveWorkbenchDist 同款：dist/ 与 dist/子目录 两种深度都能命中包根。 */
export function resolveToolchainPackageRoot (): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDirectory, '..'),
    resolve(moduleDirectory, '../..'),
    resolve(moduleDirectory, '../../..'),
  ]
  return candidates.find(candidate => existsSync(resolve(candidate, 'package.json'))) ?? candidates[0]!
}
