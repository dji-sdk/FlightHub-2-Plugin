// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import type { ContractDocument, ContractVersions, KnowledgeBundle, ListKnowledgeInput, ListKnowledgeResult, SearchKnowledgeInput, SearchKnowledgeResult } from './types.js'
import { type KnowledgeSearchIndex, buildSearchIndex } from './search.js'
import { type ContractRepository, createContractRepository, knowledgeResourceUri } from './repository.js'

export class KnowledgeArgumentError extends Error {
  readonly code = 'FH2_MCP_INVALID_ARGUMENT'

  constructor (message: string) {
    super(message)
    this.name = 'KnowledgeArgumentError'
  }
}

export interface KnowledgeService {
  readonly versions: ContractVersions;
  readonly size: number;
  readonly domains: readonly string[];
  readonly kinds: readonly string[];
  readonly kindsByDomain: Readonly<Record<string, readonly string[]>>;
  readonly repository: ContractRepository;
  list (input: ListKnowledgeInput): ListKnowledgeResult;
  search (input: SearchKnowledgeInput): SearchKnowledgeResult;
  readContract (ref: string): ContractDocument;
}

export function createKnowledgeService (bundle: KnowledgeBundle): KnowledgeService {
  const searchIndex: KnowledgeSearchIndex = buildSearchIndex(bundle.entries)
  const repository = createContractRepository(bundle)
  const sortedEntries = [...bundle.entries].sort((a, b) => a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0)
  const kindsByDomain = deriveKindsByDomain(bundle.entries)

  const validateFilters = (domain: string | undefined, kind: string | undefined): void => {
    if (domain !== undefined && !bundle.domains.includes(domain)) {
      throw new KnowledgeArgumentError(`domain 必须是 ${bundle.domains.join('/')} 之一。`)
    }
    if (kind !== undefined && !bundle.kinds.includes(kind)) {
      throw new KnowledgeArgumentError(`kind 必须是 ${bundle.kinds.join('/')} 之一。`)
    }
    if (domain !== undefined && kind !== undefined && !kindsByDomain[domain]?.includes(kind)) {
      throw new KnowledgeArgumentError(`kind "${kind}" 不属于 domain "${domain}"；${domain} 可用 kind：${kindsByDomain[domain]?.join('/') ?? '无'}。`)
    }
  }

  return {
    versions: bundle.versions,
    size: bundle.entries.length,
    domains: bundle.domains,
    kinds: bundle.kinds,
    kindsByDomain,
    repository,

    list (input: ListKnowledgeInput): ListKnowledgeResult {
      validateFilters(input.domain, input.kind)
      const offset = input.offset ?? 0
      const limit = input.limit ?? 50
      if (!Number.isInteger(offset) || offset < 0) throw new KnowledgeArgumentError('offset 必须是非负整数。')
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeArgumentError('limit 必须是 1..100 的整数。')
      const filtered = sortedEntries.filter((entry) => {
        if (input.domain !== undefined && entry.domain !== input.domain) return false
        if (input.kind !== undefined && entry.kind !== input.kind) return false
        return true
      })
      const items = filtered.slice(offset, offset + limit).map(entry => ({
        targetId: entry.targetId,
        domain: entry.domain,
        kind: entry.kind,
        summary: entry.content.summary,
        resourceUri: knowledgeResourceUri(entry.targetId),
      }))
      const nextOffset = offset + items.length < filtered.length ? offset + items.length : undefined
      return { items, total: filtered.length, offset, limit, ...(nextOffset === undefined ? {} : { nextOffset }) }
    },

    search (input: SearchKnowledgeInput): SearchKnowledgeResult {
      const query = input.query.trim()
      if (query === '') throw new KnowledgeArgumentError('query 不能为空。')
      validateFilters(input.domain, input.kind)
      const limit = input.limit ?? 5
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new KnowledgeArgumentError('limit 必须是 1..10 的整数。')
      return searchIndex.search({ query, domain: input.domain, kind: input.kind, limit }, bundle.entries)
    },

    readContract (ref: string): ContractDocument {
      const normalized = ref.trim()
      if (normalized === '') throw new KnowledgeArgumentError('ref 不能为空。')
      try {
        return repository.read(normalized)
      } catch (error) {
        throw new KnowledgeArgumentError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function deriveKindsByDomain (entries: KnowledgeBundle['entries']): Readonly<Record<string, readonly string[]>> {
  const kinds = new Map<string, Set<string>>()
  for (const entry of entries) {
    const domainKinds = kinds.get(entry.domain) ?? new Set<string>()
    domainKinds.add(entry.kind)
    kinds.set(entry.domain, domainKinds)
  }
  return Object.fromEntries(
    [...kinds.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([domain, domainKinds]) => [domain, [...domainKinds].sort()]),
  )
}

export type { KnowledgeBundle }
