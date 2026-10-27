// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { loadDeveloperRuntime, resolveDeveloperRuntimeRoot } from '../../developer-runtime/loader.js'
import type { KnowledgeBundle } from './types.js'

export { CONTRACT_PACKAGE_NAME, resolveContractRoot } from '../../contract/root.js'
export type { KnowledgeBundle, KnowledgeEntry } from './types.js'

export function loadKnowledgeBundle (contractRoot: string = resolveDeveloperRuntimeRoot()): KnowledgeBundle {
  const runtime = loadDeveloperRuntime({ root: contractRoot })
  const { formatVersion, sourceBackendDigest, publishedEntries, projectionDigest } = runtime.manifest
  return Object.freeze({
    contractRoot: runtime.root,
    entries: runtime.knowledge.entries,
    domains: Object.freeze([...new Set(runtime.knowledge.entries.map(entry => entry.domain))].sort()),
    kinds: Object.freeze([...new Set(runtime.knowledge.entries.map(entry => entry.kind))].sort()),
    rootIndexPath: runtime.rootIndexPath,
    knowledgeIndexPath: runtime.knowledgeIndexPath,
    versions: runtime.manifest.sourceVersions,
    resources: runtime.resources,
    projection: Object.freeze({ formatVersion, sourceBackendDigest, publishedEntries, projectionDigest }),
  })
}
