// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import MiniSearch from 'minisearch'
import type { SearchResult } from 'minisearch'
import type { KnowledgeEntry, SearchKnowledgeInput, SearchKnowledgeItem, SearchKnowledgeResult } from './types.js'
import { factResourceUri, knowledgeResourceUri } from './repository.js'

const SNIPPET_LIMIT = 240
const BRIEF_LIMIT = 300

interface SearchDocumentData {
  readonly id: string;
  readonly identityText: string;
  readonly kindText: string;
  readonly summaryText: string;
  readonly bodyText: string;
  readonly examplesText: string;
  readonly evidenceText: string;
  readonly domain: string;
  readonly kind: string;
  readonly targetId: string;
}

export interface KnowledgeSearchIndex {
  readonly size: number;
  search (input: SearchKnowledgeInput, entries: readonly KnowledgeEntry[]): SearchKnowledgeResult;
}

/** 稳定知识 taxonomy 的检索标签；未知新 kind 自动回退 kind 原值，不阻断结构演进。 */
const KIND_SEARCH_LABELS: Readonly<Record<string, string>> = {
  action: '动作 步骤 action',
  build: '构建 build',
  capability: '能力 权限 capability',
  command: '命令 command cli',
  diagnostic: '诊断 排错 diagnostic',
  discovery: '发现 识别 上下文 discovery',
  entrypoint: '入口 entrypoint',
  error: '错误 错误码 报错 error',
  event: '事件 event',
  language: '语言 dsl language',
  manifest: '清单 manifest',
  pack: '打包 pack',
  point: '扩展点 点位 point',
  restriction: '限制 禁止 restriction',
  transform: '转换 改写 transform',
  trigger: '触发器 触发 trigger',
}

/**
 * MiniSearch BM25+ 索引。
 *
 * - 中文同时索引单字与重叠 bigram；无需维护问句停用词或同义词正则；
 * - 标识符保留完整 token，并补充 `.`/`:`/`_`/`-` 分段；
 * - OR 召回交给 BM25 的 IDF、字段长度和命中词数排序；
 * - domain/kind 是结构化过滤，不参与全文分词；
 * - 仅英文/标识符启用 prefix 与低编辑距离 fuzzy。
 */
export function buildSearchIndex (entries: readonly KnowledgeEntry[]): KnowledgeSearchIndex {
  const documents = new Map<string, SearchDocumentData>()
  const byTargetId = new Map(entries.map(entry => [entry.targetId, entry]))
  const index = new MiniSearch<SearchDocumentData>({
    fields: ['identityText', 'kindText', 'summaryText', 'bodyText', 'examplesText', 'evidenceText'],
    storeFields: ['targetId', 'domain', 'kind'],
    tokenize: tokenizeKnowledgeText,
    searchOptions: {
      combineWith: 'OR',
      boost: { identityText: 8, kindText: 6, summaryText: 4, bodyText: 2, examplesText: 1, evidenceText: 0.5 },
      prefix: term => isAsciiIdentifier(term) && term.length >= 3,
      fuzzy: term => isAsciiIdentifier(term) && term.length >= 5 ? 0.2 : false,
    },
  })

  for (const entry of entries) {
    const document: SearchDocumentData = {
      id: entry.targetId,
      identityText: `${entry.targetId} ${entry.localId}`,
      kindText: `${entry.kind} ${KIND_SEARCH_LABELS[entry.kind] ?? entry.kind}`,
      summaryText: entry.content.summary,
      bodyText: [entry.content.developerAction, ...entry.content.useCases].join(' '),
      examplesText: entry.content.examples.join('\n'),
      evidenceText: entry.evidence.join(' '),
      domain: entry.domain,
      kind: entry.kind,
      targetId: entry.targetId,
    }
    documents.set(document.id, document)
    index.add(document)
  }

  return {
    size: documents.size,
    search (input): SearchKnowledgeResult {
      const limit = input.limit ?? 5
      const normalizedQuery = normalizeKnowledgeText(input.query.trim())
      const queryTerms = tokenizeKnowledgeText(normalizedQuery)
      const minimumMatchedTerms = Math.min(2, new Set(queryTerms).size)
      const strongTerms = new Set(queryTerms.filter(isStrongTerm))
      const raw = index.search(normalizedQuery, {
        filter: (result) => {
          if (input.domain !== undefined && result.domain !== input.domain) return false
          if (input.kind !== undefined && result.kind !== input.kind) return false
          return true
        },
      }).filter((result) => {
        const matchedTerms = new Set(result.queryTerms)
        if (matchedTerms.size < minimumMatchedTerms) return false
        if (strongTerms.size > 0 && ![...matchedTerms].some(term => strongTerms.has(term))) return false
        return true
      })

      const ranked = raw
        .map((result) => {
          const entry = byTargetId.get(String(result.targetId))
          if (entry === undefined) return undefined
          return { entry, result, exactTier: exactTierOf(normalizedQuery, entry) }
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
        .sort(compareCandidates)

      const items: SearchKnowledgeItem[] = ranked.slice(0, limit).map(({ entry, result }) => ({
        targetId: entry.targetId,
        domain: entry.domain,
        kind: entry.kind,
        snippet: snippetOf(entry, result),
        summary: entry.content.summary.slice(0, BRIEF_LIMIT),
        resourceUri: knowledgeResourceUri(entry.targetId),
        factResourceUris: entry.evidence.map(factResourceUri),
      }))
      return { items, total: ranked.length }
    },
  }
}

function normalizeKnowledgeText (text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

function tokenizeKnowledgeText (text: string): string[] {
  const normalized = normalizeKnowledgeText(text)
  const terms: string[] = []
  for (const part of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_.:-]+/gu) ?? []) {
    const characters = [...part]
    if (!characters.every(character => /\p{Script=Han}/u.test(character))) {
      terms.push(part, ...part.split(/[._:-]+/).filter(Boolean))
      continue
    }
    terms.push(...characters)
    for (let index = 0; index < characters.length - 1; index++) {
      terms.push(`${characters[index]}${characters[index + 1]}`)
    }
  }
  return terms
}

function isAsciiIdentifier (term: string): boolean {
  return /^[a-z0-9_.:-]+$/i.test(term)
}

function isStrongTerm (term: string): boolean {
  if (isAsciiIdentifier(term)) return term.length >= 3
  return [...term].length >= 2
}

function exactTierOf (query: string, entry: KnowledgeEntry): number {
  const targetId = normalizeKnowledgeText(entry.targetId)
  const localId = normalizeKnowledgeText(entry.localId)
  if (query === targetId) return 0
  if (query === localId) return 1
  if (targetId.startsWith(query)) return 2
  return 3
}

function compareCandidates (
  a: { entry: KnowledgeEntry; result: SearchResult; exactTier: number },
  b: { entry: KnowledgeEntry; result: SearchResult; exactTier: number },
): number {
  if (a.exactTier !== b.exactTier) return a.exactTier - b.exactTier
  if (a.result.score !== b.result.score) return b.result.score - a.result.score
  return a.entry.targetId < b.entry.targetId ? -1 : a.entry.targetId > b.entry.targetId ? 1 : 0
}

function snippetOf (entry: KnowledgeEntry, result: SearchResult): string {
  const matchedFields = new Set(Object.values(result.match).flat())
  const terms = result.queryTerms.length > 0 ? result.queryTerms : result.terms
  const sources: string[] = []
  if (matchedFields.has('summaryText')) sources.push(entry.content.summary)
  if (matchedFields.has('bodyText')) sources.push(entry.content.developerAction, ...entry.content.useCases)
  if (matchedFields.has('examplesText')) sources.push(...entry.content.examples)
  if (matchedFields.has('evidenceText')) sources.push(...entry.evidence)
  if (sources.length === 0) sources.push(entry.content.summary, entry.content.developerAction)

  for (const source of sources) {
    const hitIndex = firstTermIndex(source, terms)
    if (hitIndex !== -1) return snippetWindow(source, hitIndex)
  }
  return sources[0]!.slice(0, SNIPPET_LIMIT)
}

function firstTermIndex (source: string, terms: readonly string[]): number {
  const normalized = normalizeKnowledgeText(source)
  let hitIndex = -1
  for (const term of terms) {
    const found = normalized.indexOf(term)
    if (found !== -1 && (hitIndex === -1 || found < hitIndex)) hitIndex = found
  }
  return hitIndex
}

function snippetWindow (source: string, hitIndex: number): string {
  const start = Math.max(0, hitIndex - 80)
  const end = Math.min(source.length, hitIndex + 160)
  let snippet = source.slice(start, end)
  if (start > 0) snippet = `…${snippet}`
  if (end < source.length) snippet = `${snippet}…`
  return snippet.slice(0, SNIPPET_LIMIT)
}
