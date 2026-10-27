// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { importKnowledge } from '../../knowledge/install.js'
import { writeLock } from '../../knowledge/lock.js'
import { loadPlatformCatalog, resolveProjectKnowledge } from '../../knowledge/resolve.js'
import { buildKnowledgePackage } from '../../knowledge/test-fixture.js'
import { clearPlatformCatalogCache, resolveIdeActionsWithKnowledge } from './actions.js'
import { CATALOG_SOURCE_REVISION } from './catalog.js'
import { adaptPlatformCatalog, toTriggerSeed } from './knowledge-catalog.js'

/**
 * 计划 §B4 要求的「Knowledge Catalog → Core Catalog 适配测试」。
 *
 * ★★ 这组用例的目的**不是**验证适配层能跑通，而是验证它**不丢事实**：
 * 手抄快照的每一格画布真在用的语义（必填、非幂等、不恒有出参、seed 不保证），
 * 换成知识包之后必须一个不少。少一格的后果是画布少画一条红线/黄标，
 * 而那种错不会报警 —— 它表现为「一条在运行期才失败的流程通过了发布前检查」。
 */
describe('workflow/service/knowledge-catalog', () => {
  beforeEach(async () => {
    process.env.FH2_KNOWLEDGE_CACHE = await mkdtemp(join(tmpdir(), 'fh2-kb-cache-'))
    clearPlatformCatalogCache()
  })

  /** 造一个最小后端插件工程（带一份声明了 I/O 的脚本）。 */
  const makeProject = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-proj-'))
    await mkdir(join(root, 'adapters'), { recursive: true })
    await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'demo',
      name: 'demo',
      version: '0.0.1',
      flows: [],
      connections: [],
      scripts: [{
        name: 'evaluate',
        path: 'adapters/evaluate.js',
        allowlist: ['data:read'],
        io: {
          inputs: [{ name: 'eventId', type: 'id', required: true }],
          outputs: [{ name: 'decision', type: 'string' }],
        },
      }],
    }, null, 2), 'utf8')
    await writeFile(join(root, 'adapters/evaluate.js'), 'function handle () { return {} }\n', 'utf8')
    return root
  }

  const installAndLock = async (root: string): Promise<void> => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    await writeLock(root, { knowledgeId: installed.knowledgeId, bundleDigest: installed.bundleDigest })
  }

  it('run_script 不进节点菜单（它的 I/O 由脚本契约解引用，画布另给入口）', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))
    expect(adapted.fixedSteps.map(step => step.action)).not.toContain('run_script')
    // 但它的名字要被认出来：画布建脚本节点时要用它当 action。
    expect(adapted.scriptAction).toBe('run_script')
  })

  it('retry=none 才是 nonIdempotent；not-applicable 绝不能被翻成非幂等', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))

    const dispatch = adapted.fixedSteps.find(step => step.action === 'dispatch_mission')
    expect(dispatch?.nonIdempotent).toBe(true)

    const query = adapted.fixedSteps.find(step => step.action === 'query_flight_task')
    expect(query?.nonIdempotent).toBeUndefined()

    // wait_signal 不跑 activity。给它挂「重发有副作用」的徽标是错的：它没有副作用。
    const wait = adapted.fixedSteps.find(step => step.action === 'wait_signal')
    expect(wait?.nonIdempotent).toBeUndefined()
    expect(wait?.kind).toBe('await_signal')
  })

  it('always=false 的出参翻成 from 非空 —— 下游引用它要黄标', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))
    const query = adapted.fixedSteps.find(step => step.action === 'query_flight_task')
    expect(query?.outputs.find(field => field.name === 'pollTimedOut')?.from).toBeTruthy()
    // 恒有的那个不能被误标成 dynamic，否则画布对每个引用都黄一下，黄标就没人看了。
    expect(query?.outputs.find(field => field.name === 'taskStatus')?.from).toBeUndefined()
  })

  it('入参不继承 always 语义（它在 worker 侧恒为 true，翻过去会被读成「入参必给」）', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))
    const dispatch = adapted.fixedSteps.find(step => step.action === 'dispatch_mission')
    for (const field of dispatch?.inputs ?? []) expect(field.from).toBeUndefined()
    // required 要如实传下来：画布靠它画「必填未接线」的红点。
    expect(dispatch?.inputs.find(field => field.name === 'waylineUuid')?.required).toBe(true)
    expect(dispatch?.inputs.find(field => field.name === 'lat')?.required).toBeUndefined()
  })

  it('seedNotGuaranteed 一路传到画布 —— 少了它「声明≠保证」就没有机器可读表达', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))
    expect(adapted.triggerSeeds.stream?.available).toContain('lat')
    expect(adapted.triggerSeeds.stream?.notGuaranteed).toEqual(['lat', 'lng'])
    expect(adapted.triggerSeeds.bizNotify?.notGuaranteed).toEqual(['dockSn'])
    // 知识包带 seedTypes → 透传；不带（当前 worker 导出的形态）→ 没有类型表，不猜
    expect(adapted.triggerSeeds.stream?.types).toBeUndefined()
    // 透传路径的单元级验证（fixture 保持当前 worker 导出形态，不走夹具改写）：
    expect(toTriggerSeed({ name: 'stream', summary: '事件消息', seedGuarantee: '平台保证', seedKeys: ['eventId'], seedTypes: { eventId: 'string' } }).types)
      .toEqual({ eventId: 'string' })
    expect('types' in toTriggerSeed({ name: 'stream', summary: '事件消息', seedGuarantee: '平台保证', seedKeys: ['eventId'] })).toBe(false)
    // 五轴都要在场，哪怕 seed 是空的：画布的 trigger 编辑器按轴渲染。
    expect(Object.keys(adapted.triggerSeeds).sort())
      .toEqual(['api', 'bizNotify', 'job', 'schedule', 'stream'])
  })

  it('语言词表整体取自知识包，不落回硬编码', async () => {
    const pkg = await buildKnowledgePackage()
    const installed = await importKnowledge({ source: pkg.directory })
    const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))
    expect(adapted.vocabulary.runRoot).toEqual(['now', 'idempotencyKey', 'intervalSec'])
    expect(adapted.vocabulary.stepStates).toContain('timedOut')
    expect(adapted.vocabulary.conditionOps).toContain('present')
    expect(adapted.vocabulary.stepTriggers).toEqual(['allSucceeded', 'allDone'])
    expect(adapted.vocabulary.pluginActionPrefix).toBe('plugin.')
  })

  it('catalog 里没有脚本步时拒绝适配，而不是给一份用不了的菜单', async () => {
    const catalog = {
      actions: [{ name: 'x', owner: 'platform', kind: 'activity', retry: 'default', ioResolution: 'catalog' }],
      triggers: [],
      language: { runRoot: [], stepStates: [], conditionOps: [], triggerModes: [], pluginActionPrefix: 'plugin.' },
      hostApi: { grantableCapabilities: [], methods: [] },
      source: { kind: 'knowledge' as const, revision: 'x' },
    }
    expect(() => adaptPlatformCatalog(catalog as never)).toThrow(/没有「I\/O 由脚本契约决定」的动作/)
  })

  describe('resolveIdeActionsWithKnowledge', () => {
    it('未固定知识时回退到内建快照，并把原因带进回包', async () => {
      const root = await makeProject()
      const actions = await resolveIdeActionsWithKnowledge({ root })
      expect(actions.catalogSource.kind).toBe('builtin-snapshot')
      expect(actions.catalogSource.revision).toBe(CATALOG_SOURCE_REVISION)
      expect(actions.catalogSource.reason).toMatch(/还没固定知识包/)
      // 回退仍要可用：画布没有节点菜单会整个打不开。
      expect(actions.fixedSteps.length).toBeGreaterThan(0)
    })

    it('固定知识后来源变成 knowledge，且项目脚本照旧合并进来', async () => {
      const root = await makeProject()
      await installAndLock(root)
      const actions = await resolveIdeActionsWithKnowledge({ root })
      expect(actions.catalogSource.kind).toBe('knowledge')
      expect(actions.catalogSource.revision).toBe('bpk-test')
      expect(actions.catalogSource.reason).toBeUndefined()
      // 平台知识 + 项目功能是两个来源的合并，缺一个画布就不完整。
      expect(actions.scripts.map(script => script.id)).toEqual(['evaluate'])
      expect(actions.scripts[0]?.filePath).toBe('adapters/evaluate.js')
      expect(actions.fixedSteps.map(step => step.action)).toContain('dispatch_mission')
      expect(actions.grantableCaps).toContain('egress:fetch')
    })

    it('锁指向未安装的身份时不静默回退 —— 回包里要说清缺哪个', async () => {
      const root = await makeProject()
      await writeLock(root, { knowledgeId: 'bpk-missing', bundleDigest: 'f'.repeat(64) })
      const actions = await resolveIdeActionsWithKnowledge({ root })
      expect(actions.catalogSource.kind).toBe('builtin-snapshot')
      expect(actions.catalogSource.reason).toMatch(/bpk-missing/)
      expect(actions.catalogSource.reason).toMatch(/缓存里没有它/)
    })

    it('已装内容与锁的摘要不符时报出两个摘要，不悄悄用装着的那份', async () => {
      const root = await makeProject()
      const pkg = await buildKnowledgePackage()
      const installed = await importKnowledge({ source: pkg.directory })
      await writeLock(root, { knowledgeId: installed.knowledgeId, bundleDigest: '0'.repeat(64) })
      const actions = await resolveIdeActionsWithKnowledge({ root })
      expect(actions.catalogSource.kind).toBe('builtin-snapshot')
      expect(actions.catalogSource.reason).toMatch(/与项目锁不符/)
      const resolved = await resolveProjectKnowledge(root)
      expect(resolved.knowledge).toBeUndefined()
      expect(resolved.locked).toBe(true)
    })

    it('锁文件本身坏掉时也回退并说明，不抛给路由层', async () => {
      const root = await makeProject()
      await writeFile(join(root, 'backend-plugin-knowledge.lock.json'), '{ 坏', 'utf8')
      const actions = await resolveIdeActionsWithKnowledge({ root })
      expect(actions.catalogSource.kind).toBe('builtin-snapshot')
      expect(actions.catalogSource.reason).toMatch(/不是合法 JSON/)
    })
  })

  /**
   * 对着 worker 仓真产出的知识包跑一遍。
   *
   * ⓘ 真包不在时**跳过而不是失败**：单测不该要求本机有 worker 仓并先构建。
   * 它守的是「fixture 与真包同形」这件事 —— fixture 漂了就在这里露出来。
   */
  describe('对真知识包', () => {
    const realPackage = join(
      homedir(),
      'project/platform-workflow-worker/.work/kb/backend-plugin-knowledge-bpk-local',
    )

    it.skipIf(!existsSync(realPackage))('真包能装上、能适配，且关键事实都在', async () => {
      const installed = await importKnowledge({ source: realPackage })
      const adapted = adaptPlatformCatalog(loadPlatformCatalog(installed))

      expect(adapted.scriptAction).toBe('run_script')
      expect(adapted.fixedSteps.map(step => step.action)).not.toContain('run_script')
      // 手抄快照里有的这三条非幂等步，知识包必须一条不少。
      expect(adapted.fixedSteps.filter(step => step.nonIdempotent).map(step => step.action).sort())
        .toEqual(['dispatch_mission', 'return_home', 'spawn_agent'])
      // 唯一那个 dynamic 出参。它曾因 omitempty 在知识包里整条消失（2026-09-20）。
      expect(adapted.fixedSteps.find(step => step.action === 'query_flight_task')
        ?.outputs.find(field => field.name === 'pollTimedOut')?.from).toBeTruthy()
      expect([...(adapted.triggerSeeds.stream?.notGuaranteed ?? [])].sort())
        .toEqual(['flightMissionId', 'lat', 'lng'])
      expect([...(adapted.triggerSeeds.bizNotify?.notGuaranteed ?? [])].sort())
        .toEqual(['dockSn', 'droneSn', 'taskName', 'waylineUuid'])
      expect(adapted.grantableCaps.length).toBeGreaterThanOrEqual(19)
    })
  })
})
