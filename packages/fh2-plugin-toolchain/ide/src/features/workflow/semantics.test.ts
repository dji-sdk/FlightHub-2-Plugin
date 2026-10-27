// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import type { ActionsResult } from '../../api/types.js'
import { parseWorkflowDocument } from '../../../../src/workflow/core/model.js'
import { refCandidates } from '../../../../src/workflow/core/inputs.js'
import { EMPTY_CATALOG, resolveStepIO, toCatalog } from './catalog.js'
import { ACCIDENT_RESPONSE } from './canvas/fixtures.js'
import { buildClosures, buildContext, buildTriggerEnv, collectStepOutputs, parseRef, validateSemantics } from './semantics.js'
import type { ActionCatalog } from './catalog.js'

/**
 * 这组用例守的是一条纪律：**宁可漏判，不可误报**。
 *
 * 画布的红线一旦出现假阳性，用户就会开始无视所有红线 —— 那比少判一条严重得多。
 * 因此几乎每条规则都配了一个「不该报」的反面用例，它们和「该报」的用例同等重要。
 */

/** 手抄一份最小词表，形状与 `GET /api/actions` 一致。 */
const ACTIONS: ActionsResult = {
  fixedSteps: [
    {
      action: 'dispatch_mission',
      capability: 'device.mission:execute',
      isFlight: true,
      kind: 'activity',
      owner: 'platform',
      nonIdempotent: true,
      inputs: [
        { name: 'waylineUuid', type: 'id', required: true },
        { name: 'dockSn', type: 'id', required: true },
        { name: 'projectUuid', type: 'id', required: true },
        { name: 'lat', type: 'number' },
      ],
      outputs: [
        { name: 'allowed', type: 'bool' },
        { name: 'missionId', type: 'id' },
      ],
    },
    {
      action: 'query_flight_task',
      kind: 'activity',
      owner: 'platform',
      inputs: [{ name: 'missionId', type: 'id', required: true }],
      outputs: [
        { name: 'taskStatus', type: 'number' },
        // 只在轮询超时那一次产出
        { name: 'pollTimedOut', type: 'bool', from: 'dynamic' },
      ],
    },
    {
      action: 'wait_signal',
      kind: 'await_signal',
      owner: 'platform',
      inputs: [],
      outputs: [],
    },
  ],
  scripts: [
    {
      id: 'lane-change-postprocess',
      entry: 'handle',
      allowlist: ['track:read', 'video:process'],
      inputs: [
        { name: 'eventKey', type: 'string', required: true },
        { name: 'videoFileId', type: 'string' },
      ],
      outputs: [
        { name: 'verified', type: 'bool' },
        { name: 'clipFileId', type: 'string' },
      ],
    },
  ],
  triggerSeeds: {
    api: { available: [], notGuaranteed: [] },
    job: { available: [], notGuaranteed: [] },
    schedule: { available: [], notGuaranteed: [] },
    stream: {
      available: ['eventId', 'eventType', 'status', 'payload', 'lat', 'lng', 'flightMissionId'],
      notGuaranteed: ['lat', 'lng', 'flightMissionId'],
    },
    bizNotify: {
      available: ['taskUuid', 'projectUuid', 'dockSn', 'waylineUuid'],
      notGuaranteed: ['dockSn', 'waylineUuid'],
    },
  },
  runRoot: ['now', 'idempotencyKey', 'intervalSec'],
  scriptAction: 'run_script',
  pluginActionPrefix: 'plugin.',
  stepStates: ['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted'],
  conditionOps: ['eq', 'ne', 'in', 'exists', 'blank', 'present'],
  stepTriggers: ['allSucceeded', 'allDone'],
  grantableCaps: ['track:read', 'video:process'],
  pluginManifestFound: true,
  catalogRevision: 'test',
  catalogSource: { kind: 'knowledge', revision: 'test' },
}

const CATALOG: ActionCatalog = toCatalog(ACTIONS)

function check (json: unknown): readonly { rule: string; level: string; nodeId: string; message: string }[] {
  const parsed = parseWorkflowDocument(JSON.stringify(json, null, 2))
  if (!parsed.ok) throw new Error(`fixture 不是合法 JSON：${parsed.message}`)
  return validateSemantics(CATALOG, parsed.document)
}

function rules (json: unknown): string[] {
  return check(json).map(issue => issue.rule)
}

function rulesOfJson (text: string): string[] {
  const parsed = parseWorkflowDocument(text)
  if (!parsed.ok) throw new Error(`fixture 不是合法 JSON：${parsed.message}`)
  return validateSemantics(CATALOG, parsed.document).map(issue => issue.rule)
}

function contextOf (json: unknown) {
  const parsed = parseWorkflowDocument(JSON.stringify(json, null, 2))
  if (!parsed.ok) throw new Error('fixture 不是合法 JSON')
  return buildContext(CATALOG, parsed.document)
}

describe('parseRef', () => {
  it('拆得开三个根', () => {
    expect(parseRef('trigger.eventId')).toEqual({ root: 'trigger', stepId: '', rest: ['eventId'] })
    expect(parseRef('steps.pick.missionId')).toEqual({ root: 'steps', stepId: 'pick', rest: ['missionId'] })
    expect(parseRef('run.now')).toEqual({ root: 'run', stepId: '', rest: ['now'] })
  })

  it('深路径与数组下标原样带出', () => {
    expect(parseRef('trigger.payload.poi.lat')?.rest).toEqual(['payload', 'poi', 'lat'])
    expect(parseRef('steps.a.list.0.id')?.rest).toEqual(['list', '0', 'id'])
  })

  it('裸键名与只写根一律拆不开', () => {
    // 老写法的裸键名会永远取不到值，那一步再也不跑 —— 必须在编辑期拦住
    expect(parseRef('eventId')).toBeNull()
    expect(parseRef('trigger')).toBeNull()
    expect(parseRef('steps.a')).toBeNull()
  })

  it('超过深度上限时拒绝', () => {
    expect(parseRef(`trigger.${Array.from({ length: 20 }, () => 'a').join('.')}`)).toBeNull()
  })
})

describe('buildClosures', () => {
  it('算出传递闭包', () => {
    const closures = buildClosures({
      steps: [
        { id: 'a', action: 'x' },
        { id: 'b', action: 'x', needs: ['a'] },
        { id: 'c', action: 'x', needs: ['b'] },
      ],
    })
    expect([...(closures.get('c') ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('有环时不死循环', () => {
    // 环本身由结构层（toGraph）报，这里只要求不挂
    const closures = buildClosures({
      steps: [
        { id: 'a', action: 'x', needs: ['b'] },
        { id: 'b', action: 'x', needs: ['a'] },
      ],
    })
    expect(closures.size).toBe(2)
  })
})

describe('resolveStepIO', () => {
  it('run_script 按 inputs.script 解引用脚本契约，并补两个元入参', () => {
    const io = resolveStepIO(CATALOG, 'run_script', 'lane-change-postprocess')
    expect(io.isScript).toBe(true)
    expect(io.inputs.map(field => field.name)).toEqual(['eventKey', 'videoFileId', 'script', 'connectorId'])
    expect(io.outputs.map(field => field.name)).toEqual(['verified', 'clipFileId'])
  })

  it('脚本没选时只有两个元入参', () => {
    const io = resolveStepIO(CATALOG, 'run_script', undefined)
    expect(io.inputs.map(field => field.name)).toEqual(['script', 'connectorId'])
  })

  it('脚本 id 在清单里找不到时标出来', () => {
    expect(resolveStepIO(CATALOG, 'run_script', 'not-there').scriptMissing).toBe(true)
  })

  it('词表不可用时一律 unresolved（驱动 UI 降级，不校验）', () => {
    expect(resolveStepIO(EMPTY_CATALOG, 'dispatch_mission', undefined).resolved).toBe(false)
  })
})

describe('collectStepOutputs', () => {
  it('把 await 的留痕键与 provides 合成出参', () => {
    const outputs = collectStepOutputs(CATALOG, {
      id: 'ack',
      action: 'wait_signal',
      await: { signal: 'acknowledge', timeoutSec: 600, provides: ['operator'] },
    })
    const names = outputs.fields.map(field => field.name)
    expect(names).toContain('signal_acknowledge')
    expect(names).toContain('by')
    // 有超时 → 可能超时 → 这些键不是每次都有
    expect(names).toContain('timedOut')
    expect(outputs.uncertain.has('operator')).toBe(true)
  })

  it('无限等时信号必然收到，留痕键算恒有', () => {
    const outputs = collectStepOutputs(CATALOG, {
      id: 'ack',
      action: 'wait_signal',
      await: { signal: 'acknowledge', provides: ['operator'] },
    })
    expect(outputs.uncertain.has('operator')).toBe(false)
    expect(outputs.fields.map(field => field.name)).not.toContain('timedOut')
  })

  it('optional 的键一律不确定', () => {
    const outputs = collectStepOutputs(CATALOG, {
      id: 'ack',
      action: 'wait_signal',
      await: { signal: 'ack', optional: ['note'] },
    })
    expect(outputs.uncertain.has('note')).toBe(true)
  })
})

describe('buildTriggerEnv', () => {
  it('恒有 = 各轴的交集，声明 = 各轴的并集', () => {
    const env = buildTriggerEnv(CATALOG, {
      trigger: {
        stream: { match: { status: 'pending' }, seed: ['eventId', 'lat'] },
        bizNotify: { subscriber: 'x', seed: ['eventId', 'taskUuid'] },
      },
    })
    expect(env.declared.has('lat')).toBe(true)
    expect(env.declared.has('taskUuid')).toBe(true)
    // eventId 两轴都恒播 → 恒有
    expect(env.guaranteed.has('eventId')).toBe(true)
    // lat 只有 stream 有，且它本身就不保证播 → 不恒有
    expect(env.guaranteed.has('lat')).toBe(false)
    // taskUuid 只有 bizNotify 有 → 另一轴不播 → 交集里没有
    expect(env.guaranteed.has('taskUuid')).toBe(false)
  })

  it('api/job 没写 seed 时整个 trigger.* 放开（键名由作者自定，无从枚举）', () => {
    expect(buildTriggerEnv(CATALOG, { trigger: { api: {} } }).openEnded).toBe(true)
  })
})

// ── R1–R8 ────────────────────────────────────────

describe('r1 必填入参未接线', () => {
  it('必填没接 → error', () => {
    const issues = check({
      name: 'f',
      trigger: { api: { seed: ['waylineUuid'] } },
      steps: [{ id: 'go', action: 'dispatch_mission', inputs: { waylineUuid: { from: 'trigger.waylineUuid' } } }],
    })
    const missing = issues.filter(issue => issue.rule === 'R1_REQUIRED_INPUT_UNWIRED')
    // dockSn 与 projectUuid 两个必填都没接
    expect(missing).toHaveLength(2)
    expect(missing.map(issue => issue.message).join(' ')).toContain('dockSn')
  })

  it('非必填没接 → 不报', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: { seed: ['a'] } },
      steps: [{
        id: 'go',
        action: 'dispatch_mission',
        inputs: {
          waylineUuid: { const: 'w' },
          dockSn: { const: 'd' },
          projectUuid: { const: 'p' },
        },
      }],
    })
    // lat 是非必填，没接不该报
    expect(issues).not.toContain('R1_REQUIRED_INPUT_UNWIRED')
  })
})

describe('r2 声明之外的入参名', () => {
  it('拼错的入参名 → error', () => {
    const issues = check({
      name: 'f',
      trigger: { api: {} },
      steps: [{
        id: 'go',
        action: 'dispatch_mission',
        inputs: {
          waylineUuid: { const: 'w' },
          dockSn: { const: 'd' },
          projectUuid: { const: 'p' },
          // 拼错：词表里叫 lat
          latitude: { const: 1 },
        },
      }],
    })
    const extra = issues.filter(issue => issue.rule === 'R2_UNDECLARED_INPUT')
    expect(extra).toHaveLength(1)
    expect(extra[0]?.message).toContain('latitude')
  })

  it('脚本保留键不许当业务入参', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{
        id: 'go',
        action: 'run_script',
        inputs: {
          script: { const: 'lane-change-postprocess' },
          eventKey: { const: 'k' },
          // now 经 ctx 给脚本，这里再写一份会互相覆盖
          now: { const: '2026-01-01' },
        },
      }],
    })
    expect(issues).toContain('R2_UNDECLARED_INPUT')
  })
})

describe('r3 接线解析', () => {
  const base = {
    name: 'f',
    trigger: { api: { seed: ['waylineUuid', 'dockSn', 'projectUuid'] } },
  }

  it('steps.X 不在 needs 闭包里 → error', () => {
    const issues = check({
      ...base,
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: constInputs() },
        // b 没有 needs a，却引用了 a 的出参
        { id: 'b', action: 'query_flight_task', inputs: { missionId: { from: 'steps.a.missionId' } } },
      ],
    })
    const broken = issues.filter(issue => issue.rule === 'R3_UNRESOLVABLE_REF')
    expect(broken).toHaveLength(1)
    expect(broken[0]?.message).toContain('传递闭包')
  })

  it('在闭包里就放行', () => {
    const issues = rules({
      ...base,
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: constInputs() },
        { id: 'b', action: 'query_flight_task', needs: ['a'], inputs: { missionId: { from: 'steps.a.missionId' } } },
      ],
    })
    expect(issues).not.toContain('R3_UNRESOLVABLE_REF')
  })

  it('引用上游不产出的键 → error', () => {
    const issues = check({
      ...base,
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: constInputs() },
        { id: 'b', action: 'query_flight_task', needs: ['a'], inputs: { missionId: { from: 'steps.a.nope' } } },
      ],
    })
    expect(issues.some(issue => issue.rule === 'R3_UNRESOLVABLE_REF' && issue.message.includes('不产出'))).toBe(true)
  })

  it('$state 对闭包里的每一步恒有', () => {
    const issues = rules({
      ...base,
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: constInputs() },
        {
          id: 'b',
          action: 'query_flight_task',
          needs: ['a'],
          inputs: { missionId: { const: 'm' } },
          when: { field: 'steps.a.$state', op: 'eq', value: 'succeeded' },
        },
      ],
    })
    expect(issues).not.toContain('R3_UNRESOLVABLE_REF')
    expect(issues).not.toContain('R8_BAD_CONDITION')
  })

  it('run.* 根外的键 → error', () => {
    const issues = rules({
      ...base,
      steps: [{
        id: 'a',
        action: 'query_flight_task',
        inputs: { missionId: { from: 'run.nope' } },
      }],
    })
    expect(issues).toContain('R3_UNRESOLVABLE_REF')
  })

  it('trigger.* 是开放根：解不开只 warn 不 error', () => {
    const issues = check({
      name: 'f',
      trigger: { stream: { match: { status: 'pending' }, seed: ['eventId'] } },
      steps: [{
        id: 'a',
        action: 'query_flight_task',
        inputs: { missionId: { from: 'trigger.somethingElse' } },
      }],
    })
    // 关键：不能是 error —— 判错等于要求逐字段穷举
    expect(issues.some(issue => issue.rule === 'R3_UNRESOLVABLE_REF')).toBe(false)
  })

  it('必填接了「不恒有」的键且无 when 守护 → warn', () => {
    const issues = check({
      name: 'f',
      trigger: { stream: { match: { status: 'pending' }, seed: ['eventId', 'lat'] } },
      steps: [{ id: 'a', action: 'query_flight_task', inputs: { missionId: { from: 'trigger.lat' } } }],
    })
    expect(issues.some(issue => issue.rule === 'R3_UNCERTAIN_REF' && issue.level === 'warning')).toBe(true)
  })

  it('有 when 守护时不再 warn', () => {
    const issues = rules({
      name: 'f',
      trigger: { stream: { match: { status: 'pending' }, seed: ['eventId', 'lat'] } },
      steps: [{
        id: 'a',
        action: 'query_flight_task',
        inputs: { missionId: { from: 'trigger.lat' } },
        when: { field: 'trigger.lat', op: 'present' },
      }],
    })
    expect(issues).not.toContain('R3_UNCERTAIN_REF')
  })

  it('引用上游的 dynamic 出参 → warn（需 when 守护）', () => {
    const issues = check({
      name: 'f',
      trigger: { api: { seed: ['m'] } },
      steps: [
        { id: 'a', action: 'query_flight_task', inputs: { missionId: { const: 'm' } } },
        { id: 'b', action: 'query_flight_task', needs: ['a'], inputs: { missionId: { from: 'steps.a.pollTimedOut' } } },
      ],
    })
    expect(issues.some(issue => issue.rule === 'R3_UNCERTAIN_REF')).toBe(true)
  })
})

describe('r6 两个挂起步必须有先后', () => {
  it('并列的两个 await → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [
        { id: 'w1', action: 'wait_signal', await: { signal: 's1', timeoutSec: 60 } },
        { id: 'w2', action: 'wait_signal', await: { signal: 's2', timeoutSec: 60 } },
      ],
    })
    expect(issues).toContain('R6_AWAIT_ORDER')
  })

  it('连上 needs 之后不再报', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [
        { id: 'w1', action: 'wait_signal', await: { signal: 's1', timeoutSec: 60 } },
        { id: 'w2', action: 'wait_signal', needs: ['w1'], await: { signal: 's2', timeoutSec: 60 } },
      ],
    })
    expect(issues).not.toContain('R6_AWAIT_ORDER')
  })
})

describe('r7 allDone 的步不许无界等待', () => {
  it('allDone + 无超时 await → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'fin', action: 'wait_signal', trigger: 'allDone', await: { signal: 's' } }],
    })
    expect(issues).toContain('R7_ALLDONE_UNBOUNDED_AWAIT')
  })

  it('给了 timeoutSec 就放行', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'fin', action: 'wait_signal', trigger: 'allDone', await: { signal: 's', timeoutSec: 30 } }],
    })
    expect(issues).not.toContain('R7_ALLDONE_UNBOUNDED_AWAIT')
  })

  it('非 allDone 的无界等待是合法的（作者写下来的「一直等」）', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'w', action: 'wait_signal', await: { signal: 's' } }],
    })
    expect(issues).not.toContain('R7_ALLDONE_UNBOUNDED_AWAIT')
  })

  it('同时写 timeoutSec 与 timeoutSecFrom → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: { seed: ['t'] } },
      steps: [{ id: 'w', action: 'wait_signal', await: { signal: 's', timeoutSec: 30, timeoutSecFrom: 'trigger.t' } }],
    })
    expect(issues).toContain('R7_ALLDONE_UNBOUNDED_AWAIT')
  })
})

describe('r8 when 条件', () => {
  it('非法算子 → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'a', action: 'wait_signal', when: { field: 'trigger.x', op: 'gt', value: 1 } }],
    })
    expect(issues).toContain('R8_BAD_CONDITION')
  })

  it('裸键名的 field → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'a', action: 'wait_signal', when: { field: 'eventId', op: 'present' } }],
    })
    expect(issues).toContain('R8_BAD_CONDITION')
  })

  it('$state 比一个不存在的终态 → error（拦恒假拼错）', () => {
    const issues = check({
      name: 'f',
      trigger: { api: {} },
      steps: [
        { id: 'a', action: 'wait_signal' },
        // 正确写法是 timedOut；写成 timeout 会让这条 when 恒为假且没有任何报错
        { id: 'b', action: 'wait_signal', needs: ['a'], when: { field: 'steps.a.$state', op: 'eq', value: 'timeout' } },
      ],
    })
    expect(issues.some(issue => issue.rule === 'R8_BAD_CONDITION' && issue.message.includes('终态'))).toBe(true)
  })

  it('空条件 → error（守护形同虚设）', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'a', action: 'wait_signal', when: {} }],
    })
    expect(issues).toContain('R8_BAD_CONDITION')
  })

  it('and/or 组合递归校验', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{
        id: 'a',
        action: 'wait_signal',
        when: { and: [{ field: 'trigger.x', op: 'present' }, { field: 'bare', op: 'eq', value: 1 }] },
      }],
    })
    expect(issues).toContain('R8_BAD_CONDITION')
  })
})

describe('trigger 段校验', () => {
  it('一轴都没声明 → error', () => {
    expect(rules({ name: 'f', trigger: {}, steps: [] })).toContain('R8_BAD_CONDITION')
  })

  it('schedule 缺 intervalSec → error', () => {
    const issues = check({ name: 'f', trigger: { schedule: {} }, steps: [] })
    expect(issues.some(issue => issue.message.includes('intervalSec'))).toBe(true)
  })

  it('stream 的 match 为空 → error（会匹配到全部消息）', () => {
    const issues = check({ name: 'f', trigger: { stream: { seed: ['eventId'] } }, steps: [] })
    expect(issues.some(issue => issue.message.includes('match'))).toBe(true)
  })

  it('bizNotify 缺 subscriber → error', () => {
    const issues = check({ name: 'f', trigger: { bizNotify: { seed: [] } }, steps: [] })
    expect(issues.some(issue => issue.message.includes('subscriber'))).toBe(true)
  })
})

describe('run_script 专属校验', () => {
  it('inputs.script 写成接线 → error（必须 const）', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: { seed: ['s'] } },
      steps: [{ id: 'a', action: 'run_script', inputs: { script: { from: 'trigger.s' } } }],
    })
    expect(issues).toContain('SCRIPT_META_NOT_CONST')
  })

  it('没给 inputs.script → error', () => {
    const issues = rules({ name: 'f', trigger: { api: {} }, steps: [{ id: 'a', action: 'run_script' }] })
    expect(issues).toContain('SCRIPT_META_NOT_CONST')
  })

  it('引用的脚本不在清单里 → error', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'a', action: 'run_script', inputs: { script: { const: 'ghost' } } }],
    })
    expect(issues).toContain('SCRIPT_MISSING')
  })

  it('脚本的必填入参没接 → error', () => {
    const issues = check({
      name: 'f',
      trigger: { api: {} },
      steps: [{ id: 'a', action: 'run_script', inputs: { script: { const: 'lane-change-postprocess' } } }],
    })
    expect(issues.some(issue =>
      issue.rule === 'R1_REQUIRED_INPUT_UNWIRED' && issue.message.includes('eventKey'))).toBe(true)
  })
})

describe('未知动作', () => {
  it('不在词表里的裸名 → error', () => {
    const issues = rules({ name: 'f', trigger: { api: {} }, steps: [{ id: 'a', action: 'no_such_step' }] })
    expect(issues).toContain('UNKNOWN_ACTION')
  })

  it('plugin.<名> 只 warn（运行期可分派，只是不受审）', () => {
    const issues = check({ name: 'f', trigger: { api: {} }, steps: [{ id: 'a', action: 'plugin.custom' }] })
    const unknown = issues.filter(issue => issue.rule === 'UNKNOWN_ACTION')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.level).toBe('warning')
  })
})

describe('连坐跳过警告', () => {
  it('上游带 when 而本步默认 allSucceeded → warn', () => {
    const issues = check({
      name: 'f',
      trigger: { api: { seed: ['x'] } },
      steps: [
        { id: 'a', action: 'wait_signal', when: { field: 'trigger.x', op: 'present' } },
        { id: 'b', action: 'wait_signal', needs: ['a'] },
      ],
    })
    expect(issues.some(issue => issue.message.includes('连坐跳过'))).toBe(true)
  })

  it('本步改 allDone 后不再 warn', () => {
    const issues = check({
      name: 'f',
      trigger: { api: { seed: ['x'] } },
      steps: [
        { id: 'a', action: 'wait_signal', when: { field: 'trigger.x', op: 'present' } },
        { id: 'b', action: 'wait_signal', needs: ['a'], trigger: 'allDone', await: { signal: 's', timeoutSec: 10 } },
      ],
    })
    expect(issues.some(issue => issue.message.includes('连坐跳过'))).toBe(false)
  })
})

describe('词表不可用时整体降级', () => {
  it('一条语义问题都不报（环境问题不该渲染成用户的错误）', () => {
    const parsed = parseWorkflowDocument(JSON.stringify({
      name: 'f',
      trigger: {},
      steps: [{ id: 'a', action: 'whatever', inputs: { bogus: { from: 'nonsense' } } }],
    }))
    if (!parsed.ok) throw new Error('fixture 不合法')
    const issues = validateSemantics(EMPTY_CATALOG, parsed.document)
    expect(issues).toHaveLength(0)
  })
})

describe('refCandidates', () => {
  it('只列 needs 闭包里的上游（闭包外从源头就不出现）', () => {
    const context = contextOf({
      name: 'f',
      trigger: { api: { seed: ['seedKey'] } },
      steps: [
        { id: 'a', action: 'dispatch_mission', inputs: constInputs() },
        { id: 'far', action: 'dispatch_mission', inputs: constInputs() },
        { id: 'b', action: 'query_flight_task', needs: ['a'], inputs: { missionId: { const: 'm' } } },
      ],
    })
    const paths = refCandidates(context, 'b').map(candidate => candidate.path)
    expect(paths).toContain('steps.a.missionId')
    expect(paths).toContain('steps.a.$state')
    // far 不在 b 的闭包里 —— 一个候选都不该出现
    expect(paths.some(path => path.startsWith('steps.far.'))).toBe(false)
  })

  it('三个根都给，run.* 恒在', () => {
    const context = contextOf({ name: 'f', trigger: { api: { seed: ['k'] } }, steps: [] })
    const paths = refCandidates(context, 'x').map(candidate => candidate.path)
    expect(paths).toContain('trigger.k')
    expect(paths).toContain('run.now')
    expect(paths).toContain('run.idempotencyKey')
  })

  it('没声明 schedule 时 run.intervalSec 标成不恒有', () => {
    const context = contextOf({ name: 'f', trigger: { api: {} }, steps: [] })
    const interval = refCandidates(context, 'x').find(candidate => candidate.path === 'run.intervalSec')
    expect(interval?.guaranteed).toBe(false)
  })

  it('声明了 schedule 后 run.intervalSec 恒有', () => {
    const context = contextOf({ name: 'f', trigger: { schedule: { intervalSec: 60 } }, steps: [] })
    const interval = refCandidates(context, 'x').find(candidate => candidate.path === 'run.intervalSec')
    expect(interval?.guaranteed).toBe(true)
  })

  it('不恒有的 trigger 键标黄并给出原因', () => {
    const context = contextOf({
      name: 'f',
      trigger: { stream: { match: { status: 'pending' }, seed: ['eventId', 'lat'] } },
      steps: [],
    })
    const lat = refCandidates(context, 'x').find(candidate => candidate.path === 'trigger.lat')
    expect(lat?.guaranteed).toBe(false)
    expect(lat?.note).toBeDefined()
  })
})

function constInputs (): Record<string, { const: string }> {
  return { waylineUuid: { const: 'w' }, dockSn: { const: 'd' }, projectUuid: { const: 'p' } }
}

/**
 * R9 冗余 needs（ordering-edge-semantics plan §6）。
 *
 * ★ ACCIDENT_RESPONSE 必须**零命中**：它的 5 条纯顺序边全都不是冗余的
 *   （mark_ack 不在 dispatch 的祖先闭包里）—— 那正是它们存在的理由。
 *   把「零命中」钉住，防止判据写松把「该保留的边」劝删。
 */
describe('r9 冗余 needs 警告', () => {
  it('aCCIDENT_RESPONSE 零命中：5 条纯顺序边都不是冗余的', () => {
    const issues = rulesOfJson(ACCIDENT_RESPONSE)
    expect(issues).not.toContain('R9_REDUNDANT_NEEDS')
  })

  it('needs 写全（上游已在其它前置的闭包里且不取值）→ warn', () => {
    const issues = check({
      name: 'f',
      trigger: { api: {} },
      steps: [
        { id: 'ack', action: 'wait_signal' },
        { id: 'pick', action: 'wait_signal', needs: ['ack'] },
        // pick 已保证排在 ack 之后，且 mark 不读 ack 任何产出 → 冗余
        { id: 'mark', action: 'update_event_status', needs: ['ack', 'pick'] },
      ],
    })
    const redundant = issues.filter(issue => issue.rule === 'R9_REDUNDANT_NEEDS')
    expect(redundant).toHaveLength(1)
    expect(redundant[0]!.nodeId).toBe('mark')
    expect(redundant[0]!.message).toContain('ack')
  })

  it('本步引用了上游产出（数据/判据）→ 不冗余，不报', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: { seed: ['eventId'] } },
      steps: [
        { id: 'ack', action: 'wait_signal' },
        { id: 'pick', action: 'wait_signal', needs: ['ack'], await: { signal: 's', timeoutSec: 5 } },
        { id: 'mark', action: 'update_event_status', needs: ['ack', 'pick'], inputs: { eventId: { from: 'steps.ack.eventId' } } },
      ],
    })
    expect(issues).not.toContain('R9_REDUNDANT_NEEDS')
  })

  it('中间步是 allDone 时不判冗余（删边会改变跳过传染语义，plan §6 前置条件）', () => {
    const issues = rules({
      name: 'f',
      trigger: { api: {} },
      steps: [
        { id: 'ack', action: 'wait_signal' },
        // finish 是 allDone：它「有终态」不蕴含 ack「成功」
        { id: 'finish', action: 'update_event_status', needs: ['ack'], trigger: 'allDone' },
        { id: 'mark', action: 'update_event_status', needs: ['ack', 'finish'] },
      ],
    })
    expect(issues).not.toContain('R9_REDUNDANT_NEEDS')
  })
})
