// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { collectBackendRuntimeKeys } from '../backend/contract.js'
import type { BackendRuntimeKeys } from '../backend/contract.js'
import { validateBackendSourcePlugin } from '../backend/source-contract.js'
import { validateSourceManifest } from '../validate/index.js'
import type { CapabilityProject } from './types.js'

export interface CapabilityValidationDiagnostic {
  readonly side: 'capability' | 'frontend' | 'backend';
  readonly code: string;
  readonly message: string;
  readonly pluginId?: string;
  readonly file?: string;
}

export type CapabilityValidationResult = {
  readonly ok: true;
  readonly capability: CapabilityProject;
  readonly diagnostics: readonly [];
} | {
  readonly ok: false;
  readonly capability: CapabilityProject;
  readonly diagnostics: readonly CapabilityValidationDiagnostic[];
}

export function validateCapability (
  capability: CapabilityProject,
  validateFrontend: typeof validateSourceManifest = validateSourceManifest,
): CapabilityValidationResult {
  const diagnostics: CapabilityValidationDiagnostic[] = []
  const backendRuntimeOwners = {
    flows: new Map<string, string>(),
    scripts: new Map<string, string>(),
    connections: new Map<string, string>(),
    entities: new Map<string, string>(),
  }
  for (const frontend of capability.frontend) {
    try {
      const result = validateFrontend({ manifestPath: frontend.manifestPath })
      if (!result.ok) {
        diagnostics.push(...result.diagnostics.map(item => ({
          side: 'frontend' as const,
          pluginId: frontend.id,
          code: item.code,
          message: item.message,
          ...(item.file === undefined ? {} : { file: item.file }),
        })))
      } else if (result.manifest.id !== frontend.id) {
        diagnostics.push({
          side: 'frontend',
          pluginId: frontend.id,
          code: 'FH2_CAPABILITY_FRONTEND_ID_MISMATCH',
          file: frontend.manifestPath,
          message: `前端插件目录身份 ${frontend.id} 与当前 fh2-plugin.json.id ${result.manifest.id} 不一致。`,
        })
      }
    } catch (error) {
      diagnostics.push({
        side: 'frontend',
        pluginId: frontend.id,
        code: 'FH2_CAPABILITY_PLUGIN_DISCOVERY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const backend of capability.backend) {
    // 后端目录是作者源码：Source Contract 允许受约束 ESM（import/export 由 Backend Bundler 消化），
    // Runtime Contract 只对 Bundle 后的 dist 生效（build/pack 内部执行）。
    const result = validateBackendSourcePlugin(backend.root)
    if (!result.ok) {
      diagnostics.push(...result.diagnostics.map(item => ({
        side: 'backend' as const,
        pluginId: backend.id,
        code: item.code,
        message: item.message,
        file: item.file,
      })))
      continue
    }
    if (result.manifest!.pluginId !== backend.id) {
      diagnostics.push({
        side: 'backend',
        pluginId: backend.id,
        code: 'FH2_CAPABILITY_BACKEND_ID_MISMATCH',
        file: backend.manifestPath,
        message: `后端插件目录身份 ${backend.id} 与当前 fh2-plugin.json.pluginId ${result.manifest!.pluginId} 不一致。`,
      })
      continue
    }
    validateBackendRuntimeKeys(
      backend.id,
      backend.manifestPath,
      collectBackendRuntimeKeys(backend.root, result.manifest!),
      backendRuntimeOwners,
      diagnostics,
    )
  }
  return diagnostics.length === 0
    ? { ok: true, capability, diagnostics: [] }
    : { ok: false, capability, diagnostics }
}

function validateBackendRuntimeKeys (
  pluginId: string,
  manifestPath: string,
  keys: BackendRuntimeKeys,
  owners: {
    readonly flows: Map<string, string>;
    readonly scripts: Map<string, string>;
    readonly connections: Map<string, string>;
    readonly entities: Map<string, string>;
  },
  diagnostics: CapabilityValidationDiagnostic[],
): void {
  validateBackendRuntimeNamespace('流程', keys.flows, owners.flows)
  validateBackendRuntimeNamespace('脚本键', keys.scripts, owners.scripts)
  validateBackendRuntimeNamespace('Connection ID', keys.connections, owners.connections)
  validateBackendRuntimeNamespace('Entity 名', keys.entities, owners.entities)

  function validateBackendRuntimeNamespace (
    kind: string,
    values: readonly string[],
    namespace: Map<string, string>,
  ): void {
    for (const value of values) {
      const previous = namespace.get(value)
      if (previous !== undefined) {
        diagnostics.push({
          side: 'backend',
          pluginId,
          code: 'FH2_CAPABILITY_BACKEND_NAMESPACE_CONFLICT',
          file: manifestPath,
          message: `后端 ${kind} ${JSON.stringify(value)} 与 ${previous} 重复；Worker 合并后会拒绝启动。`,
        })
      } else {
        namespace.set(value, pluginId)
      }
    }
  }
}

export function formatCapabilityValidationResult (
  result: CapabilityValidationResult,
  format: 'text' | 'json' = 'text',
): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`
  const lines = [`[capability ${result.capability.capabilityId}] capabilities.json 校验通过`]
  if (result.ok) {
    for (const frontend of result.capability.frontend)
      lines.push(`[frontend ${frontend.id}] validate success`)
    for (const backend of result.capability.backend)
      lines.push(`[backend ${backend.id}] validate success`)
    return `${lines.join('\n')}\n`
  }
  for (const diagnostic of result.diagnostics) {
    const plugin = diagnostic.pluginId === undefined ? '' : ` ${diagnostic.pluginId}`
    const file = diagnostic.file === undefined ? '' : ` ${diagnostic.file}`
    lines.push(`[${diagnostic.side}${plugin}] ${diagnostic.code}${file}\n${diagnostic.message}`)
  }
  return `${lines.join('\n')}\n`
}
