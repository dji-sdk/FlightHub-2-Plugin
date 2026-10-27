// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseStrictJson } from '../validate/json-reader.js'
import { CapabilityError } from './types.js'
import type { CapabilityProject, IndustryCapabilityWorkspaceProject } from './types.js'

const MIGRATION_LINKS_FILE = 'migration-links.json'

/**
 * 迁移期映射只服务于行业 Capability 工作区。文件不存在时无条件跳过，避免把它变成
 * 新工作区或常规 Capability 的输入契约。
 */
export function validateIndustryMigrationLinks (workspace: IndustryCapabilityWorkspaceProject): void {
  const file = join(workspace.root, MIGRATION_LINKS_FILE)
  if (!existsSync(file)) return

  const links = readJsonObject(file, 'FH2_MIGRATION_LINKS_SCHEMA_INVALID')
  if (links.schemaVersion !== 1) {
    throw new CapabilityError(
      'FH2_MIGRATION_LINKS_SCHEMA_INVALID',
      `${file} 的 schemaVersion 必须为 1。`,
      file,
    )
  }
  const capabilityLinks = links.capabilities
  if (!isRecord(capabilityLinks)) {
    throw new CapabilityError(
      'FH2_MIGRATION_LINKS_SCHEMA_INVALID',
      `${file} 缺少 capabilities JSON 对象。`,
      file,
    )
  }

  const capabilities = new Map(workspace.capabilities.map(capability => [capability.capabilityId, capability]))
  for (const [capabilityId, value] of Object.entries(capabilityLinks)) {
    const capability = capabilities.get(capabilityId)
    if (capability === undefined) {
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_CAPABILITY_UNKNOWN',
        `${file} 声明的 Capability ${JSON.stringify(capabilityId)} 不在当前工作区中；可用值：${display(capabilities.keys())}。`,
        file,
      )
    }
    if (!isRecord(value)) {
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_SCHEMA_INVALID',
        `${file} 的 capabilities.${JSON.stringify(capabilityId)} 必须是 JSON 对象。`,
        file,
      )
    }

    const frontend = readStringArray(value.frontend, `capabilities.${JSON.stringify(capabilityId)}.frontend`, file)
    const backend = readStringArray(value.backend, `capabilities.${JSON.stringify(capabilityId)}.backend`, file)
    const flows = readStringArray(value.flows, `capabilities.${JSON.stringify(capabilityId)}.flows`, file)
    assertMembers(frontend, capability.frontend.map(project => project.id), 'frontend', capabilityId, file)
    assertMembers(backend, capability.backend.map(project => project.id), 'backend', capabilityId, file)

    if (flows.length === 0) continue
    const workflowNames = collectWorkflowNames(capability)
    for (const flow of flows) {
      if (workflowNames.has(flow)) continue
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_FLOW_NOT_FOUND',
        `${file} 的 Capability ${capabilityId} 引用了不存在的 workflow name ${JSON.stringify(flow)}；可用值：${display(workflowNames)}。`,
        file,
      )
    }
  }
}

function assertMembers (
  ids: readonly string[],
  available: readonly string[],
  side: 'frontend' | 'backend',
  capabilityId: string,
  file: string,
): void {
  const members = new Set(available)
  for (const id of ids) {
    if (members.has(id)) continue
    throw new CapabilityError(
      side === 'frontend' ? 'FH2_MIGRATION_LINKS_FRONTEND_NOT_FOUND' : 'FH2_MIGRATION_LINKS_BACKEND_NOT_FOUND',
      `${file} 的 Capability ${capabilityId} 引用了未发现的 ${side} 成员 ${JSON.stringify(id)}；可用值：${display(available)}。`,
      file,
    )
  }
}

/** 只读取每个 backend 成员的 workflows 目录下的 Workflow JSON；不解析任何前端业务源码。 */
function collectWorkflowNames (capability: CapabilityProject): ReadonlySet<string> {
  const names = new Set<string>()
  for (const backend of capability.backend) {
    const workflowRoot = join(backend.root, 'workflows')
    if (!existsSync(workflowRoot)) continue
    const backendRoot = realpathSync(backend.root)
    collectWorkflowNamesFromDirectory(workflowRoot, backendRoot, names)
  }
  return names
}

function collectWorkflowNamesFromDirectory (
  directory: string,
  backendRoot: string,
  names: Set<string>,
): void {
  let realDirectory: string
  try {
    realDirectory = realpathSync(directory)
  } catch (error) {
    throw new CapabilityError(
      'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
      `无法读取后端 workflow 目录 ${directory}：${message(error)}。`,
      directory,
    )
  }
  if (!isContained(backendRoot, realDirectory)) {
    throw new CapabilityError(
      'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
      `后端 workflow 目录真实路径越过插件根：${directory}。`,
      directory,
    )
  }
  let entries
  try {
    entries = readdirSync(realDirectory, { withFileTypes: true })
  } catch (error) {
    throw new CapabilityError(
      'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
      `无法遍历后端 workflow 目录 ${directory}：${message(error)}。`,
      directory,
    )
  }
  for (const entry of entries) {
    const path = join(realDirectory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
        `后端 workflow 不支持符号链接：${path}。`,
        path,
      )
    }
    if (entry.isDirectory()) {
      collectWorkflowNamesFromDirectory(path, backendRoot, names)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const workflowPath = realpathSync(path)
    if (!isContained(backendRoot, workflowPath)) {
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
        `后端 workflow JSON 真实路径越过插件根：${path}。`,
        path,
      )
    }
    const workflow = readJsonObject(workflowPath, 'FH2_MIGRATION_LINKS_WORKFLOW_INVALID')
    if (typeof workflow.name !== 'string' || workflow.name.trim() === '') {
      throw new CapabilityError(
        'FH2_MIGRATION_LINKS_WORKFLOW_INVALID',
        `${workflowPath} 缺少非空 workflow name，无法校验 ${MIGRATION_LINKS_FILE}。`,
        workflowPath,
      )
    }
    names.add(workflow.name)
  }
}

function readStringArray (
  value: unknown,
  field: string,
  file: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new CapabilityError('FH2_MIGRATION_LINKS_SCHEMA_INVALID', `${file} 的 ${field} 必须是字符串数组。`, file)
  }
  const values: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new CapabilityError('FH2_MIGRATION_LINKS_SCHEMA_INVALID', `${file} 的 ${field} 必须只包含非空字符串。`, file)
    }
    values.push(item)
  }
  return values
}

function readJsonObject (file: string, code: string): Record<string, unknown> {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    throw new CapabilityError(code, `无法读取 ${file}：${message(error)}。`, file)
  }
  const parsed = parseStrictJson(source, file)
  if (!parsed.ok) {
    throw new CapabilityError(code, `${file} 不是严格 JSON：${parsed.diagnostics.map(item => item.message).join(' ')}`, file)
  }
  if (!isRecord(parsed.parsed.value)) {
    throw new CapabilityError(code, `${file} 必须是 JSON 对象。`, file)
  }
  return parsed.parsed.value
}

function display (values: Iterable<string>): string {
  const sorted = [...values].sort(compareText)
  return sorted.length === 0 ? '（无）' : sorted.join(', ')
}

function isContained (root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
