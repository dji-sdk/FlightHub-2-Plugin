// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import type { ContractDocument, KnowledgeBundle, KnowledgeEntry } from './types.js'

export const CONTRACT_META_URI = 'fh2-contract://meta'
export const CONTRACT_INDEX_URI = 'fh2-contract://index'
export const KNOWLEDGE_INDEX_URI = 'fh2-contract://knowledge-index'

export function knowledgeResourceUri (targetId: string): string {
  return `fh2-contract://knowledge/${encodeURIComponent(targetId)}`
}

export function factResourceUri (factRef: string): string {
  return `fh2-contract://fact/${Buffer.from(factRef).toString('base64url')}`
}

export interface ContractRepository {
  readonly bundle: KnowledgeBundle;
  readonly entries: readonly KnowledgeEntry[];
  read (ref: string): ContractDocument;
  readKnowledge (targetId: string): ContractDocument;
  readFact (factRef: string): ContractDocument;
  readFile (relativePath: string): ContractDocument;
}

export function createContractRepository (bundle: KnowledgeBundle): ContractRepository {
  const byTargetId = new Map(bundle.entries.map(entry => [entry.targetId, entry]))

  const repository: ContractRepository = {
    bundle,
    entries: bundle.entries,

    read (ref: string): ContractDocument {
      if (ref.startsWith('fh2-contract://knowledge/')) return repository.readKnowledge(decodeURIComponent(new URL(ref).pathname.slice(1)))
      if (ref.startsWith('fh2-contract://fact/')) return repository.readFact(Buffer.from(new URL(ref).pathname.slice(1), 'base64url').toString())
      if (ref.startsWith('fh2-contract://file/')) return repository.readFile(decodeURIComponent(new URL(ref).pathname.slice(1)))
      if (byTargetId.has(ref)) return repository.readKnowledge(ref)
      if (ref.includes('#') || Object.hasOwn(bundle.resources.facts, ref)) return repository.readFact(ref)
      return repository.readFile(ref)
    },

    readKnowledge (targetId: string): ContractDocument {
      const entry = byTargetId.get(targetId)
      if (entry === undefined) throw new Error(`未知知识条目：${targetId}。请先调用 search_knowledge。`)
      return { ref: targetId, resourceUri: knowledgeResourceUri(targetId), mimeType: 'application/json', value: entry, resolved: true }
    },

    readFact (factRef: string): ContractDocument {
      if (!Object.hasOwn(bundle.resources.facts, factRef)) throw new Error(`契约事实未发布或不存在：${factRef}`)
      const fact = bundle.resources.facts[factRef]!
      return {
        ref: factRef,
        resourceUri: factResourceUri(factRef),
        mimeType: 'application/json',
        value: fact.resolved ? fact.value : null,
        resolved: fact.resolved,
        ...(fact.warning === undefined ? {} : { warning: fact.warning }),
      }
    },

    readFile (relativePath: string): ContractDocument {
      if (!Object.hasOwn(bundle.resources.files, relativePath)) throw new Error(`契约资源未发布或不存在：${relativePath}`)
      return { ref: relativePath, resourceUri: `fh2-contract://file/${encodeURIComponent(relativePath)}`, mimeType: 'application/json', value: bundle.resources.files[relativePath], resolved: true }
    },
  }
  return repository
}
