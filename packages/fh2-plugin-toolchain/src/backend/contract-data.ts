// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { loadDeveloperRuntime } from '../developer-runtime/loader.js'
import type { DeveloperRuntimeBackend, DeveloperRuntimeOptions } from '../developer-runtime/types.js'

export interface BackendContractFacts {
  readonly contractRoot: string;
  readonly contractsVersion: string;
  readonly contractStatus: string;
  readonly contractDigest: string;
  readonly sourceBackendDigest: string;
  readonly projectionDigest: string;
  readonly capabilities: readonly string[];
  readonly sourceManifestSchema: Readonly<Record<string, unknown>>;
  readonly runtimeManifestSchema: Readonly<Record<string, unknown>>;
  readonly workflowSchema: Readonly<Record<string, unknown>>;
  readonly hostApi: DeveloperRuntimeBackend;
}

/** Backend consumers use the same verified projection and cache as IDE and MCP. */
export function loadBackendContractFacts (options: DeveloperRuntimeOptions = {}): BackendContractFacts {
  const runtime = loadDeveloperRuntime(options)
  return Object.freeze({
    contractRoot: runtime.root,
    contractsVersion: runtime.backend.contractsVersion,
    contractStatus: runtime.manifest.sourceVersions.contractStatus,
    contractDigest: runtime.manifest.sourceVersions.contractDigest,
    sourceBackendDigest: runtime.manifest.sourceBackendDigest,
    projectionDigest: runtime.manifest.projectionDigest,
    capabilities: runtime.backend.capabilities,
    sourceManifestSchema: runtime.schemas.sourceManifest,
    runtimeManifestSchema: runtime.schemas.runtimeManifest,
    workflowSchema: runtime.schemas.workflow,
    hostApi: runtime.backend,
  })
}
