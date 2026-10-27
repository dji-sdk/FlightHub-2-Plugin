// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PluginManifest } from 'fh2-plugin-sdk'

export type BuildPhase = 'config' | 'generate' | 'resolve' | 'compile' | 'dist' | 'commit'

export interface BuildDiagnostic {
  readonly code: string;
  readonly phase: BuildPhase;
  readonly file?: string;
  readonly message: string;
  readonly hint?: string;
  /** B1：esbuild 诊断保留 severity；未提供时消费方按 error 处理。 */
  readonly severity?: 'error' | 'warning';
  /** B1：1-based 行列（esbuild 列偏移已在 compiler 侧 +1 转换）。 */
  readonly line?: number;
  readonly column?: number;
}

export interface PluginBuildEvent {
  readonly type: 'success' | 'failure' | 'fatal';
  readonly buildId: number;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly distManifest?: PluginManifest;
  /** Capability 编排构建延迟提交时，由调用方负责提交或回滚的候选目录。 */
  readonly candidateRoot?: string;
  /** 本轮构建实际解析到的源码/配置依赖。 */
  readonly watchDependencies?: readonly string[];
  /** Rsbuild 实际加载的配置文件。 */
  readonly configPath?: string;
}

export interface PluginBuildSession {
  readonly firstBuild: Promise<void>;
  readonly done: Promise<
    | { readonly reason: 'closed' }
    | { readonly reason: 'fatal'; readonly diagnostics: readonly BuildDiagnostic[] }
  >;
  close: () => Promise<void>;
}

export interface PluginBuildRunnerOptions {
  readonly cwd: string;
  readonly configPath?: string;
  readonly expectedManifestPath?: string;
  /** false 时仅构建前端；缺省时自动检测 backend/plugin.json。 */
  readonly includeBackend?: boolean;
  /** true 时保留候选 dist，调用方负责跨插件原子提交或回滚。 */
  readonly deferCommit?: boolean;
  /** 候选 dist 校验完成、替换现有 dist 前的调用方门禁。 */
  readonly beforeCommit?: () => void | Promise<void>;
  readonly watch: boolean;
  readonly onEvent?: (event: PluginBuildEvent) => void;
}

export class PluginBuildError extends Error {
  readonly diagnostics: readonly BuildDiagnostic[]
  readonly watchDependencies: readonly string[]

  constructor (diagnostics: readonly BuildDiagnostic[], watchDependencies: readonly string[] = []) {
    super(diagnostics.map(diagnostic => diagnostic.message).join('\n'))
    this.name = 'PluginBuildError'
    this.diagnostics = diagnostics
    this.watchDependencies = watchDependencies
  }
}

export function buildError (
  phase: BuildPhase,
  code: string,
  error: unknown,
  file?: string,
): PluginBuildError {
  return new PluginBuildError([{
    code,
    phase,
    ...(file === undefined ? {} : { file }),
    message: error instanceof Error ? error.message : String(error),
  }])
}
