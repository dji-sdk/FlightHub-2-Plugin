// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CATALOG_SOURCE_REVISION, readWorkspaceScripts, resolveIdeActions } from './catalog.js'

/**
 * `GET /api/actions` 是画布的节点菜单数据源（契约 §9）。
 *
 * 这组用例守两件事：
 *   ① 受审词表快照与 worker 的 catalog.go 形状一致（必填项、dynamic 出参、非幂等标记）
 *   ② 读 plugin.json 时**任何异常都不该 500** —— 那个文件正被用户编辑，半截 JSON 是常态
 */

const temporaries: string[] = []

function workspace (files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-actions-'))
  temporaries.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return root
}

afterEach(() => {
  for (const root of temporaries.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('受审词表快照', () => {
  const actions = resolveIdeActions({ root: workspace({}) })

  it('列出平台受审步骤，且不含 *_test 空转步', () => {
    const names = actions.fixedSteps.map(step => step.action)
    expect(names).toContain('dispatch_mission')
    expect(names).toContain('query_flight_task')
    expect(names).toContain('wait_signal')
    // 空转步是 worker 自己验编排用的，放进节点菜单会被误当成可用能力
    expect(names.some(name => name.endsWith('_test'))).toBe(false)
    // run_script 的 I/O 因脚本而异，不进固定词表
    expect(names).not.toContain('run_script')
  })

  it('dispatch_mission 的三个必填与 worker 一致', () => {
    const step = actions.fixedSteps.find(item => item.action === 'dispatch_mission')
    const required = step?.inputs.filter(field => field.required === true).map(field => field.name)
    expect(required?.sort()).toEqual(['dockSn', 'projectUuid', 'waylineUuid'])
  })

  it('标出飞行意图与非幂等（画布要给红色警示）', () => {
    const step = actions.fixedSteps.find(item => item.action === 'dispatch_mission')
    expect(step?.isFlight).toBe(true)
    expect(step?.nonIdempotent).toBe(true)
  })

  it('pollTimedOut 标成 dynamic（不是每次都产出）', () => {
    const step = actions.fixedSteps.find(item => item.action === 'query_flight_task')
    const output = step?.outputs.find(field => field.name === 'pollTimedOut')
    expect(output?.from).toBe('dynamic')
  })

  it('wait_signal 是挂起型，不吃能力入参', () => {
    const step = actions.fixedSteps.find(item => item.action === 'wait_signal')
    expect(step?.kind).toBe('await_signal')
    expect(step?.inputs).toHaveLength(0)
  })

  it('三个根与算子表与 worker 对齐', () => {
    expect(actions.runRoot).toEqual(['now', 'idempotencyKey', 'intervalSec'])
    expect(actions.stepStates).toEqual(['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted'])
    expect(actions.conditionOps).toEqual(['eq', 'ne', 'in', 'exists', 'blank', 'present'])
    expect(actions.stepTriggers).toEqual(['allSucceeded', 'allDone'])
  })

  it('stream / bizNotify 的「声明了也可能不播」与 worker 一致', () => {
    expect([...actions.triggerSeeds.stream!.notGuaranteed].sort())
      .toEqual(['flightMissionId', 'lat', 'lng'])
    expect([...actions.triggerSeeds.bizNotify!.notGuaranteed].sort())
      .toEqual(['dockSn', 'droneSn', 'taskName', 'waylineUuid'])
  })

  it('api / job 没有平台固定可播表（seed 键名由作者自定）', () => {
    expect(actions.triggerSeeds.api!.available).toHaveLength(0)
    expect(actions.triggerSeeds.job!.available).toHaveLength(0)
    // 平台已知键的值类型（手抄 worker 运行期事实）：stream 的 payload 是对象、坐标是数
    expect(actions.triggerSeeds.stream!.types).toMatchObject({ payload: 'object', lat: 'number', eventId: 'string' })
    expect(actions.triggerSeeds.bizNotify!.types).toMatchObject({ occurredAt: 'number', taskType: 'number', taskUuid: 'string' })
    // 类型表只覆盖 available 里的键（写错键名会在界面上显示成孤立徽标）
    for (const key of Object.keys(actions.triggerSeeds.stream!.types ?? {})) {
      expect(actions.triggerSeeds.stream!.available).toContain(key)
    }
    for (const key of Object.keys(actions.triggerSeeds.bizNotify!.types ?? {})) {
      expect(actions.triggerSeeds.bizNotify!.available).toContain(key)
    }
    // api/job 键由作者自定，平台给不出类型
    expect(actions.triggerSeeds.api!.types).toBeUndefined()
    expect(actions.triggerSeeds.job!.types).toBeUndefined()
  })

  it('带上对账基准串', () => {
    expect(actions.catalogRevision).toBe(CATALOG_SOURCE_REVISION)
  })
})

describe('读 plugin.json 的 scripts[]', () => {
  it('从 backend/plugin.json 解出脚本 I/O', () => {
    const root = workspace({
      'backend/plugin.json': JSON.stringify({
        pluginId: 'demo',
        scripts: [{
          name: 'lane-change-postprocess',
          path: 'adapters/lane.js',
          entry: 'handle',
          allowlist: ['track:read'],
          io: {
            inputs: [{ name: 'eventKey', type: 'string', required: true }],
            outputs: [{ name: 'verified', type: 'bool' }],
          },
        }],
      }),
    })
    const { scripts, found } = readWorkspaceScripts(root)
    expect(found).toBe(true)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]?.id).toBe('lane-change-postprocess')
    expect(scripts[0]?.inputs[0]).toEqual({ name: 'eventKey', type: 'string', required: true })
    expect(scripts[0]?.allowlist).toEqual(['track:read'])
  })

  it('path 与 filePath 分列：前者相对清单，后者相对工作根', () => {
    // 真踩过的坑：拿 path 去调 /api/file 会 404 ——
    // worker 按清单目录解 path，而文件接口按工作根解，backend/ 布局下差一层。
    const root = workspace({
      'backend/plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's', path: 'adapters/s.js' }] }),
    })
    const script = readWorkspaceScripts(root).scripts[0]
    expect(script?.path).toBe('adapters/s.js')
    expect(script?.filePath).toBe('backend/adapters/s.js')
  })

  it('清单在根目录时两者相同（没有额外目录层）', () => {
    const root = workspace({
      'plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's', path: 'adapters/s.js' }] }),
    })
    const script = readWorkspaceScripts(root).scripts[0]
    expect(script?.path).toBe('adapters/s.js')
    expect(script?.filePath).toBe('adapters/s.js')
  })

  it('回报清单自身的位置（画布新建脚本要写回它）', () => {
    expect(readWorkspaceScripts(workspace({ 'backend/fh2-plugin.json': '{"pluginId":"exp_backend","scripts":[]}' })).manifestPath)
      .toBe('backend/fh2-plugin.json')
    expect(readWorkspaceScripts(workspace({ 'fh2-plugin.json': '{"pluginId":"exp_backend","scripts":[]}' })).manifestPath)
      .toBe('fh2-plugin.json')
    expect(readWorkspaceScripts(workspace({ 'backend/plugin.json': '{"pluginId":"exp_backend","scripts":[]}' })).manifestPath)
      .toBe('backend/plugin.json')
    expect(readWorkspaceScripts(workspace({ 'plugin.json': '{"pluginId":"exp_backend","scripts":[]}' })).manifestPath)
      .toBe('plugin.json')
  })

  it('源码清单 fh2-plugin.json 优先于兼容的旧名 plugin.json', () => {
    const root = workspace({
      'backend/fh2-plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's1', io: { inputs: [], outputs: [] } }] }),
      'backend/plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's2', io: { inputs: [], outputs: [] } }] }),
    })
    expect(readWorkspaceScripts(root).scripts.map(script => script.id)).toEqual(['s1'])
  })

  it('也认根目录的 plugin.json（纯后端工程布局）', () => {
    const root = workspace({
      'plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's1', io: { inputs: [], outputs: [] } }] }),
    })
    expect(readWorkspaceScripts(root).scripts.map(script => script.id)).toEqual(['s1'])
  })

  it('旧结构优先识别 backend 子目录', () => {
    const root = workspace({
      'backend/plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 'from-backend' }] }),
      'plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 'from-root' }] }),
    })
    expect(readWorkspaceScripts(root).scripts.map(script => script.id)).toEqual(['from-backend'])
  })

  it('解析嵌套 fields', () => {
    const root = workspace({
      'plugin.json': JSON.stringify({
        pluginId: 'exp_backend',
        scripts: [{
          name: 's',
          io: {
            inputs: [],
            outputs: [{
              name: 'result',
              type: 'object',
              fields: [{ name: 'id', type: 'string' }],
            }],
          },
        }],
      }),
    })
    expect(readWorkspaceScripts(root).scripts[0]?.outputs[0]?.fields?.[0]?.name).toBe('id')
  })

  it('没有 plugin.json 时回空且 found=false', () => {
    const { scripts, found } = readWorkspaceScripts(workspace({}))
    expect(scripts).toHaveLength(0)
    expect(found).toBe(false)
  })

  it('plugin.json 是半截 JSON 时不抛（用户正在编辑是常态）', () => {
    const root = workspace({ 'plugin.json': '{ "scripts": [' })
    expect(() => readWorkspaceScripts(root)).not.toThrow()
    expect(readWorkspaceScripts(root).scripts).toHaveLength(0)
  })

  it('没有 scripts[] 时回空但 found=true（文件在，只是没脚本）', () => {
    const root = workspace({ 'plugin.json': JSON.stringify({ pluginId: 'x' }) })
    const { scripts, found } = readWorkspaceScripts(root)
    expect(scripts).toHaveLength(0)
    expect(found).toBe(true)
  })

  it('跳过没有 name 的条目（name 是寻址键，没有它引用不了）', () => {
    const root = workspace({
      'plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ path: 'a.js' }, { name: 'ok' }] }),
    })
    expect(readWorkspaceScripts(root).scripts.map(script => script.id)).toEqual(['ok'])
  })

  it('io 字段形状不对时当空，不抛', () => {
    const root = workspace({
      'plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 's', io: { inputs: 'not-an-array' } }] }),
    })
    expect(readWorkspaceScripts(root).scripts[0]?.inputs).toHaveLength(0)
  })
})

describe('resolveIdeActions', () => {
  it('把词表与工程脚本装在一个回包里', () => {
    const root = workspace({
      'backend/plugin.json': JSON.stringify({ pluginId: 'exp_backend', scripts: [{ name: 'my-script' }] }),
    })
    const actions = resolveIdeActions({ root })
    expect(actions.fixedSteps.length).toBeGreaterThan(0)
    expect(actions.scripts.map(script => script.id)).toEqual(['my-script'])
    expect(actions.pluginManifestFound).toBe(true)
    expect(actions.scriptAction).toBe('run_script')
    expect(actions.pluginActionPrefix).toBe('plugin.')
  })
})

describe('多后端归属', () => {
  it('按工作流所属后端隔离脚本，同名脚本不会串入其他后端；前端不是脚本清单', () => {
    const root = workspace({
      'capabilities.json': JSON.stringify({ name: 'Two', description: 'test' }),
      'backend/exp_a/fh2-plugin.json': JSON.stringify({ pluginId: 'exp_a', scripts: [{ name: 'shared', path: 'adapters/a.ts' }] }),
      'backend/exp_b/fh2-plugin.json': JSON.stringify({ pluginId: 'exp_b', scripts: [{ name: 'shared', path: 'adapters/b.ts' }] }),
      'frontend/exp_ui/fh2-plugin.json': JSON.stringify({ id: 'exp_ui', scripts: [{ name: 'wrong' }] }),
    })
    expect(resolveIdeActions({ root, workflowPath: 'backend/exp_a/workflows/a.json' }).scripts[0]?.filePath).toBe('backend/exp_a/adapters/a.ts')
    expect(resolveIdeActions({ root, workflowPath: 'backend/exp_b/workflows/a.json' }).scripts[0]?.filePath).toBe('backend/exp_b/adapters/b.ts')
    expect(resolveIdeActions({ root, workflowPath: 'frontend/exp_ui/workflows/a.json' }).pluginManifestFound).toBe(false)
    expect(resolveIdeActions({ root }).scripts).toEqual([])
  })
})

describe('resolveScriptLanguage（P0-1：新建业务功能按工程语言档案）', () => {
  it('独立后端插件工程：有 .ts 源 → typescript；只有 .js → javascript', () => {
    const tsRoot = workspace({
      'fh2-plugin.json': JSON.stringify({ pluginId: 'exp_ts', scripts: [{ name: 's', path: 'adapters/s.ts' }] }),
      'tsconfig.json': '{}',
      'adapters/s.ts': 'export function handle () { return {} }',
    })
    expect(resolveIdeActions({ root: tsRoot }).scriptLanguage).toBe('typescript')

    const jsRoot = workspace({
      'fh2-plugin.json': JSON.stringify({ pluginId: 'exp_js', scripts: [{ name: 's', path: 'adapters/s.js' }] }),
      'adapters/s.js': 'function handle (input) { return {} }',
    })
    expect(resolveIdeActions({ root: jsRoot }).scriptLanguage).toBe('javascript')
  })

  it('capability 工程：按 workflow 归属的后端成员判定，两个成员语言可不同', () => {
    const root = workspace({
      'packages.json': JSON.stringify({ name: 'ws', version: '0.0.0' }),
      'capabilities.json': JSON.stringify({
        capabilities: [{ id: 'cap_a', frontend: ['frontend/ui'], backend: ['backend/ts_side', 'backend/js_side'] }],
      }),
      'backend/ts_side/fh2-plugin.json': JSON.stringify({ pluginId: 'exp_ts_side', scripts: [{ name: 's', path: 'adapters/a.ts' }] }),
      'backend/ts_side/adapters/a.ts': 'export function handle () { return {} }',
      'backend/js_side/fh2-plugin.json': JSON.stringify({ pluginId: 'exp_js_side', scripts: [{ name: 's', path: 'adapters/b.js' }] }),
      'backend/js_side/adapters/b.js': 'function handle (input) { return {} }',
      'backend/ts_side/workflows/x.json': '{}',
      'backend/js_side/workflows/y.json': '{}',
    })
    expect(resolveIdeActions({ root, workflowPath: 'backend/ts_side/workflows/x.json' }).scriptLanguage).toBe('typescript')
    expect(resolveIdeActions({ root, workflowPath: 'backend/js_side/workflows/y.json' }).scriptLanguage).toBe('javascript')
  })

  it('快照动作带中文名 displayName（P1-1：业务语言主标题）', () => {
    const actions = resolveIdeActions({ root: workspace({}) })
    const dispatch = actions.fixedSteps.find(step => step.action === 'dispatch_mission')
    expect(dispatch?.displayName).toBe('下发飞行任务')
    const wait = actions.fixedSteps.find(step => step.action === 'wait_signal')
    expect(wait?.displayName).toBe('等待人工信号')
  })
})
