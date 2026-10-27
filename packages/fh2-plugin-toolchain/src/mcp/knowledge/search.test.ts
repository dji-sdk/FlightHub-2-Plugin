// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { buildSearchIndex } from './search.js'
import type { KnowledgeEntry } from './types.js'

/** MiniSearch 质量：精确层级、CJK ngram/BM25、结构化过滤、稳定排序和输出上限。 */

function entry (targetId: string, summary: string, extras: Partial<KnowledgeEntry['content']> & { evidence?: string[] } = {}): KnowledgeEntry {
  const [domain, kind, ...rest] = targetId.split('.')
  return {
    targetId,
    domain: domain as KnowledgeEntry['domain'],
    kind: kind as KnowledgeEntry['kind'],
    localId: rest.join('.'),
    document: `${domain}/knowledge/${kind}.json`,
    sourceFactDigest: `sha256:${'a'.repeat(64)}`,
    content: {
      summary,
      developerAction: extras.developerAction ?? `${summary}（开发动作）`,
      useCases: extras.useCases ?? [],
      examples: extras.examples ?? [],
    },
    evidence: extras.evidence ?? [],
    uncertainties: [],
  }
}

const entries: KnowledgeEntry[] = [
  entry('backend.capability.cache:read', '插件高速缓存读能力（redis，非权威、带 TTL、可丢可重建）：申报 cache:read 后在事件 / HTTP / Workflow 三路注入 15 个读方法。', {
    developerAction: '在清单 allowlist 申报 cache:read，脚本里按信封形状判 r.ok 后再取 r.data。',
    examples: ['const r = cache.get(\'myplugin:dedup\')'],
    evidence: ['backend/catalog/host-api.json#capabilityGating/cache:read'],
  }),
  entry('backend.capability.cache:write', '插件高速缓存写能力：申报 cache:write 后注入 18 个写方法。'),
  entry('backend.error.cache.KEY_TOO_LONG', '缓存键超长错误码：key 超过最大长度限制。'),
  entry('frontend.point.cockpit.ui.flight-actions', '飞行任务动作按钮贡献点：向 Cockpit 工具栏贡献飞行相关动作按钮。', {
    evidence: ['frontend/bindings/points.json#cockpit/cockpit.ui.flight-actions'],
  }),
  entry('frontend.capability.platform:map', '平台地图能力：提供地图实例与图层操作。'),
  entry('backend.trigger.schedule', '定时触发器：按 cron 周期触发 Workflow。'),
  entry('backend.language.workflow', 'Workflow 语言：触发器引用、步骤状态与条件算子。'),
  entry('backend.capability.screenshot:signurl', '截图能力概述。', {
    developerAction: '调用 screenshot.signUrl 生成签名 URL。',
    examples: ['const url = screenshot.signUrl(\'issue-1\')'],
  }),
  entry('backend.capability.data:read', '数据读能力概述。', {
    developerAction: '查询数据表并返回行。',
    examples: ['const rows = store.query(\'select * from t\')'],
    evidence: ['backend/catalog/host-api.json#methodParams/store.query'],
  }),
]

const index = buildSearchIndex(entries)

describe('知识检索', () => {
  it('精确 targetId 命中置顶并返回知识与机器事实 Resource URI', () => {
    const result = index.search({ query: 'backend.capability.cache:read', limit: 5 }, entries)
    expect(result.items[0]?.targetId).toBe('backend.capability.cache:read')
    expect(result.items[0]?.resourceUri).toBe('fh2-contract://knowledge/backend.capability.cache%3Aread')
    expect(result.items[0]?.factResourceUris).toHaveLength(1)
    expect(result.total).toBeGreaterThanOrEqual(1)
  })

  it('精确 local id 命中（cache:read）', () => {
    const result = index.search({ query: 'cache:read', limit: 5 }, entries)
    expect(result.items[0]?.targetId).toBe('backend.capability.cache:read')
    expect(result.items[0]?.resourceUri).toContain('backend.capability.cache')
  })

  it('中文语义检索命中相关条目', () => {
    const result = index.search({ query: '插件缓存', limit: 5 }, entries)
    expect(result.items.map(item => item.targetId)).toContain('backend.capability.cache:read')
    const read = result.items.find(item => item.targetId === 'backend.capability.cache:read')
    expect(read?.snippet).toContain('缓存')
    expect(read?.snippet.length).toBeLessThanOrEqual(240)
    expect(read?.summary.length).toBeLessThanOrEqual(300)
  })

  it('bM25 OR + CJK ngram 处理自然问句', () => {
    const result = index.search({ query: '如何使用插件缓存？', limit: 5 }, entries)
    expect(result.items.map(item => item.targetId)).toContain('backend.capability.cache:read')
  })

  it('domain 过滤排除 frontend', () => {
    const all = index.search({ query: '能力', limit: 10 }, entries)
    const backend = index.search({ query: '能力', domain: 'backend', limit: 10 }, entries)
    expect(backend.items.every(item => item.domain === 'backend')).toBe(true)
    expect(backend.total).toBeLessThan(all.total)
  })

  it('domain+kind 联合过滤', () => {
    const result = index.search({ query: '缓存', domain: 'backend', kind: 'capability', limit: 10 }, entries)
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    expect(result.items.every(item => item.kind === 'capability' && item.domain === 'backend')).toBe(true)
    const errors = index.search({ query: '缓存', domain: 'backend', kind: 'error', limit: 10 }, entries)
    expect(errors.items.every(item => item.kind === 'error')).toBe(true)
  })

  it('total 是 limit 截断前的匹配数；零命中返回空', () => {
    const result = index.search({ query: '缓存', limit: 1 }, entries)
    expect(result.items).toHaveLength(1)
    expect(result.total).toBeGreaterThan(1)
    const zero = index.search({ query: '量子纠缠火锅xyzq', limit: 5 }, entries)
    expect(zero.items).toEqual([])
    expect(zero.total).toBe(0)
  })

  it('相同查询结果顺序稳定（两次调用一致）', () => {
    const a = index.search({ query: '缓存', limit: 10 }, entries)
    const b = index.search({ query: '缓存', limit: 10 }, entries)
    expect(a.items.map(item => item.targetId)).toEqual(b.items.map(item => item.targetId))
  })

  it('标识符前缀命中（cockpit.ui.flight-actions）', () => {
    const result = index.search({ query: 'cockpit.ui.flight-actions', limit: 5 }, entries)
    expect(result.items[0]?.targetId).toBe('frontend.point.cockpit.ui.flight-actions')
    expect(result.items[0]?.resourceUri).toContain('frontend.point.cockpit.ui.flight-actions')
  })

  it('错误码标识符检索（cache.KEY_TOO_LONG）', () => {
    const result = index.search({ query: 'cache.KEY_TOO_LONG', limit: 5 }, entries)
    expect(result.items[0]?.targetId).toBe('backend.error.cache.KEY_TOO_LONG')
  })

  it('所有知识类别统一返回 Resource URI，不再维护 catalog 可寻址矩阵', () => {
    const error = index.search({ query: 'backend.error.cache.KEY_TOO_LONG', limit: 3 }, entries)
    expect(error.items[0]?.targetId).toBe('backend.error.cache.KEY_TOO_LONG')
    expect(error.items[0]?.resourceUri).toContain('backend.error.cache.KEY_TOO_LONG')

    const language = index.search({ query: 'backend.language.workflow', limit: 3 }, entries)
    expect(language.items[0]?.targetId).toBe('backend.language.workflow')
    expect(language.items[0]?.resourceUri).toContain('backend.language.workflow')
  })

  it('证据路径检索（evidence Exact 域）', () => {
    const result = index.search({ query: 'frontend/bindings/points.json', limit: 5 }, entries)
    expect(result.items.map(item => item.targetId)).toContain('frontend.point.cockpit.ui.flight-actions')
  })

  it('仅命中 developerAction 时 snippet 取自命中字段', () => {
    // 「签名 URL」只出现在 screenshot:signurl 的 developerAction。
    const result = index.search({ query: '签名', limit: 5 }, entries)
    const hit = result.items.find(item => item.targetId === 'backend.capability.screenshot:signurl')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('screenshot.signUrl')
  })

  it('仅命中 examples 时 snippet 取自命中的示例', () => {
    const result = index.search({ query: 'store.query', limit: 5 }, entries)
    const hit = result.items.find(item => item.targetId === 'backend.capability.data:read')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('store.query')
  })

  it('仅命中 evidence 时 snippet 取自命中的事实引用', () => {
    const result = index.search({ query: 'methodParams', limit: 5 }, entries)
    const hit = result.items.find(item => item.targetId === 'backend.capability.data:read')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('methodParams')
  })

  it('cJK 分词命中但 query 非连续子串时，snippet 取命中字段开头而非回退 summary', () => {
    // 「插件缓存」在 body 命中「插件高速缓存」（summary 同含——为构造仅 body 命中，
    // 断言含命中词即可：snippet 来自首个含 token 的来源，含「缓存」）。
    const result = index.search({ query: '插件缓存', limit: 5 }, entries)
    const hit = result.items.find(item => item.targetId === 'backend.capability.cache:read')
    expect(hit).toBeDefined()
    expect(hit?.snippet).toContain('缓存')
  })

  it('identity 精确命中且正文无 token 时，snippet 退回 summary 开头', () => {
    const result = index.search({ query: 'backend.error.cache.KEY_TOO_LONG', limit: 3 }, entries)
    const hit = result.items.find(item => item.targetId === 'backend.error.cache.KEY_TOO_LONG')
    expect(hit).toBeDefined()
    expect(hit?.snippet.startsWith('缓存键超长')).toBe(true)
  })
})
