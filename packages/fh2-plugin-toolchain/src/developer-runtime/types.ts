// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import type { ContractVersions, KnowledgeEntry } from '../mcp/knowledge/types.js'

export const DEVELOPER_RUNTIME_PACKAGE_NAME = 'fh2-plugin-toolchain'

/** The manifest inventory is ordered by raw ASCII, not by locale. */
export const DEVELOPER_RUNTIME_FILES = Object.freeze([
  'backend.json',
  'knowledge.json',
  'resources.json',
  'schemas/backend-plugin-runtime.schema.json',
  'schemas/backend-plugin-source.schema.json',
  'schemas/workflow.schema.json',
] as const)

export const BACKEND_FORM_ROOTS = Object.freeze([
  { dir: 'handlers', form: 'httpHandler' },
  { dir: 'events', form: 'eventHandler' },
  { dir: 'adapters', form: 'workflowAdapter' },
] as const)

export interface DeveloperRuntimeManifest {
  readonly kind: 'fh2-developer-runtime';
  readonly formatVersion: 1;
  readonly sourceVersions: ContractVersions;
  readonly sourceBackendDigest: string;
  readonly publishedEntries: number;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly projectionDigest: string;
}

export interface DeveloperRuntimeBackend {
  readonly contractsVersion: string;
  readonly capabilities: readonly string[];
  readonly forms: Readonly<Record<string, { readonly globals: Readonly<Record<string, readonly string[]>> }>>;
  readonly capabilityGating: Readonly<Record<string, {
    readonly forms: readonly string[];
    readonly globals: Readonly<Record<string, readonly string[]>>;
  }>>;
}

export interface DeveloperRuntimeResources {
  readonly facts: Readonly<Record<string, {
    readonly value: unknown;
    readonly resolved: boolean;
    readonly warning?: string;
  }>>;
  readonly files: Readonly<Record<string, unknown>>;
}

export type DeveloperRuntimeProjection = Pick<DeveloperRuntimeManifest, 'formatVersion' | 'sourceBackendDigest' | 'publishedEntries' | 'projectionDigest'>

export interface DeveloperRuntime {
  readonly root: string;
  readonly manifest: DeveloperRuntimeManifest;
  readonly backend: DeveloperRuntimeBackend;
  readonly knowledge: { readonly locale: string; readonly entries: readonly KnowledgeEntry[] };
  readonly resources: DeveloperRuntimeResources;
  readonly schemas: {
    readonly sourceManifest: Readonly<Record<string, unknown>>;
    readonly runtimeManifest: Readonly<Record<string, unknown>>;
    readonly workflow: Readonly<Record<string, unknown>>;
  };
  readonly rootIndexPath: string;
  readonly knowledgeIndexPath: string;
}

export interface DeveloperRuntimeOptions {
  /** Explicit fixture root for tests; production uses the installed Toolchain package. */
  readonly root?: string;
}
