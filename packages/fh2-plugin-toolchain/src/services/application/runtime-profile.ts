// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_PATHS } from '../../project-policy.js'
import { inspectProject } from './inspect.js'

/**
 * S1b：Runtime Profile Application Service。
 *
 * 为语言服务（L1）与 Typecheck（B2a/B2b）提供真实配置事实：
 * - 前端：tsconfig、是否含 Vue、生成类型位置；后端：tsconfig、types/、schema.sql、源语言；
 * - 后端环境的事实来自后端自己的 tsconfig/生成类型，不继承前端 DOM lib（前后端隔离）。
 */

export interface FrontendLanguageProfile {
  readonly id: string;
  readonly root: string;
  readonly tsconfigPath: string;
  readonly hasVue: boolean;
  /** src/generated/plugin-types.ts（存在时）。 */
  readonly generatedTypesPath?: string;
  readonly configPath?: string;
}

export interface BackendLanguageProfile {
  readonly id: string;
  readonly root: string;
  readonly tsconfigPath: string;
  readonly typesDir?: string;
  readonly schemaSqlPath?: string;
  readonly sourceLanguage: 'typescript' | 'javascript';
}

export interface RuntimeProfile {
  readonly kind: import('../../contracts/index.js').WorkspaceKind;
  readonly root: string;
  readonly frontend: readonly FrontendLanguageProfile[];
  readonly backend: readonly BackendLanguageProfile[];
}

export function resolveRuntimeProfile (rawRoot: string): RuntimeProfile {
  const root = resolve(rawRoot)
  const inspection = inspectProject(root)
  if (inspection.kind === 'capability-project' || inspection.kind === 'industry-capability-workspace') {
    const capabilities = inspection.kind === 'capability-project'
      ? [{ id: inspection.name, relativePath: '.', members: inspection.members }]
      : inspection.capabilities
    const frontend: FrontendLanguageProfile[] = []
    const backend: BackendLanguageProfile[] = []
    for (const capability of capabilities) {
      for (const item of capability.members) {
        const projectRoot = resolve(root, item.relativePath)
        if (item.side === 'frontend') {
          frontend.push(frontendProfile(item.id, projectRoot))
        } else {
          backend.push(backendProfile(item.id, projectRoot))
        }
      }
    }
    return { kind: inspection.kind, root, frontend, backend }
  }
  if (inspection.kind === 'frontend-plugin') {
    return { kind: inspection.kind, root, frontend: [frontendProfile(inspection.name, root)], backend: [] }
  }
  if (inspection.kind === 'backend-plugin') {
    return { kind: inspection.kind, root, frontend: [], backend: [backendProfile(inspection.name, root)] }
  }
  return { kind: inspection.kind, root, frontend: [], backend: [] }
}

function frontendProfile (id: string, projectRoot: string): FrontendLanguageProfile {
  const tsconfigPath = join(projectRoot, PROJECT_PATHS.tsconfig)
  const srcDir = join(projectRoot, PROJECT_PATHS.frontendSource)
  const generatedTypesPath = join(projectRoot, PROJECT_PATHS.generatedTypes, PROJECT_PATHS.generatedTypesFile)
  const configCandidates = ['rsbuild.config.ts', 'rsbuild.config.mjs', 'rsbuild.config.js']
  const configPath = configCandidates.find(candidate => existsSync(join(projectRoot, candidate)))
  return {
    id,
    root: projectRoot,
    tsconfigPath,
    hasVue: directoryContainsVue(srcDir),
    ...(existsSync(generatedTypesPath) ? { generatedTypesPath } : {}),
    ...(configPath === undefined ? {} : { configPath: join(projectRoot, configPath) }),
  }
}

function backendProfile (id: string, projectRoot: string): BackendLanguageProfile {
  const tsconfigPath = join(projectRoot, PROJECT_PATHS.tsconfig)
  const typesDir = join(projectRoot, PROJECT_PATHS.backendTypes)
  const schemaSqlPath = join(projectRoot, PROJECT_PATHS.schemaSql)
  const language: 'typescript' | 'javascript' = resolveBackendSourceLanguage(projectRoot)
  return {
    id,
    root: projectRoot,
    tsconfigPath,
    ...(existsSync(typesDir) ? { typesDir } : {}),
    ...(existsSync(schemaSqlPath) ? { schemaSqlPath } : {}),
    sourceLanguage: language,
  }
}

function directoryContainsVue (directory: string): boolean {
  return directoryContainsExtensionDeep(directory, 'vue', 4, { skipDeclarationFiles: false })
}

/**
 * 后端源码目录（与 workflow/service/catalog.ts 的 BACKEND_SOURCE_DIRS 保持一致；
 * 不能直接 import 那边——它 import 本模块，反向会成环。清单漂移由
 * runtime-profile.test.ts 的用例共同钉住）。
 */
const BACKEND_SOURCE_DIRS: readonly string[] = ['adapters', 'handlers', 'shared', 'events']

/**
 * 后端工程的语言判定（DAG-020-03 的调和规则）：
 *   ① 源码目录（adapters/handlers/shared/events）深扫到非 .d.ts 的 .ts → typescript；
 *   ② 其余情况 → javascript：只有 .js、没有源码，或只有生成的 .d.ts 声明。
 *      纯声明不算 TS 工程，否则 flow-only 成员会被要求提供 tsconfig。
 * ⚠️ 只扫源码目录：release/ 打包产物里的 scripts/handlers.js（TS 工程打包后也有）
 *    绝不能参与判定，否则打包过的 TS 工程会被误判回 javascript。
 */
function resolveBackendSourceLanguage (projectRoot: string): 'typescript' | 'javascript' {
  for (const dir of BACKEND_SOURCE_DIRS) {
    const directory = join(projectRoot, dir)
    if (directoryContainsExtensionDeep(directory, 'ts', 8, { skipDeclarationFiles: true })) return 'typescript'
  }
  return 'javascript'
}

function directoryContainsExtensionDeep (
  directory: string,
  extension: string,
  maxDepth: number,
  { skipDeclarationFiles }: { skipDeclarationFiles: boolean },
): boolean {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.fh2') continue
    if (entry.isFile() && entry.name.endsWith(`.${extension}`)) {
      if (skipDeclarationFiles && entry.name.endsWith('.d.ts')) continue
      return true
    }
    if (entry.isDirectory() && maxDepth > 1 && directoryContainsExtensionDeep(join(directory, entry.name), extension, maxDepth - 1, { skipDeclarationFiles })) {
      return true
    }
  }
  return false
}
