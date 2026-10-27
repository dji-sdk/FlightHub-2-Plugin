// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { PackageManifestEntry } from '../package/types.js'

export interface CapabilityMetadata {
  readonly name: string;
  readonly description: string;
}

export interface FrontendPluginProject {
  readonly id: string;
  readonly root: string;
  readonly manifestPath: string;
}

export interface BackendPluginProject {
  readonly id: string;
  readonly root: string;
  readonly manifestPath: string;
}

export interface CapabilityProject {
  /** 工作区 kind 值已从旧 `capability` 迁移为 `capability-project`（Wave 0 / C2），不保留旧值。 */
  readonly kind: 'capability-project';
  readonly root: string;
  readonly capabilityId: string;
  readonly metadataPath: string;
  readonly metadata: CapabilityMetadata;
  readonly frontend: readonly FrontendPluginProject[];
  readonly backend: readonly BackendPluginProject[];
}

/** 一个 packages.json 管理多个直接 Capability 子目录的行业工作区。 */
export interface IndustryCapabilityWorkspaceProject {
  readonly kind: 'industry-capability-workspace';
  readonly root: string;
  readonly packageManifestPath: string;
  readonly packageManifest: PackageManifestEntry;
  readonly capabilities: readonly CapabilityProject[];
}

export interface FrontendPluginContext {
  readonly kind: 'frontend-plugin';
  readonly root: string;
  readonly manifestPath: string;
}

export interface BackendPluginContext {
  readonly kind: 'backend-plugin';
  readonly root: string;
  readonly manifestPath: string;
}

export type CommandContext =
  | CapabilityProject
  | IndustryCapabilityWorkspaceProject
  | FrontendPluginContext
  | BackendPluginContext

export class CapabilityError extends Error {
  constructor (
    readonly code: string,
    message: string,
    readonly file?: string,
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}
