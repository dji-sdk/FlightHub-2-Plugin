// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Manifest 规范（SDK 设计 §3）。
 *
 * 三个字段是「构建产物 Manifest 专有」——由 Toolchain 写入，
 * 源 Manifest 中出现即构建失败：`manifestVersion`、`engines`、`buildInfo`。
 */

import type { PermissionId } from '../catalog/capabilities.js'
import type { PointId } from '../catalog/points/index.js'

/** 配置字段只允许三种标量，且每个字段都必须有 default（§3.3） */
export type ConfigFieldSchema =
  | { type: 'boolean'; default: boolean; label: string }
  | { type: 'number'; default: number; label: string; min?: number; max?: number }
  | { type: 'string'; default: string; label: string; enum?: readonly string[] }

export type PluginConfigSchema = Record<string, ConfigFieldSchema>

/**
 * Extension 只表达「本插件要向哪个 Point 贡献什么」，不含代码入口。
 *
 * Manifest 里只放**结构性**信息。标题、图标、标签这类呈现性内容一律不在这里——
 * 真实场景中它们都是动态的（按钮 tooltip 在禁用时要换成禁用原因），
 * 钉成静态值会立刻失真。呈现性内容属于契约的 `state`。
 */
export interface ExtensionDeclaration {
  readonly id: string;
  readonly point: PointId;
  /** 其余字段由目标 Point 契约的 static 部分决定 */
  readonly [field: string]: unknown;
}

export interface ViewResource {
  readonly entry: string;
  /** 作者可省略；Toolchain 构建时写入与该 View entry 关联的 CSS */
  readonly styles?: readonly string[];
}

export interface IconResource {
  readonly id: string;
  readonly src: string;
}

export interface BuildInfo {
  /** 构建时**实际解析到**的 SDK 版本，精确版本号而非范围 */
  readonly sdkVersion: string;
  /** 执行构建的 Toolchain 版本 */
  readonly toolchainVersion: string;
}

export interface PluginManifest {
  /** 构建产物专有；由 Toolchain 写入 */
  readonly manifestVersion?: number;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  /** 构建产物专有；由 Toolchain 写入 */
  readonly engines?: { readonly platform: string };
  readonly entry: string;
  readonly permissions?: readonly PermissionId[];
  readonly extensions: readonly ExtensionDeclaration[];
  readonly views?: Readonly<Record<string, ViewResource>>;
  readonly contributes?: { readonly icons?: readonly IconResource[] };
  readonly config?: PluginConfigSchema;
  /** 构建产物专有；由 Toolchain 写入 */
  readonly buildInfo?: BuildInfo;
}
