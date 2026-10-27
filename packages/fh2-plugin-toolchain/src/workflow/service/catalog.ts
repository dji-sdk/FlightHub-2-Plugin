// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * `GET /api/actions` 的数据源：画布的**节点菜单**。
 *
 * 为什么 schema 不够（这是本模块存在的唯一理由）：
 * `workflow.schema.json` 只回答「这份 JSON 形状合不合法」——它知道 step 必须有
 * `action: string`，但不知道 `dispatch_mission` 吃哪些入参、哪些必填、吐哪些出参。
 * 画布要画出「必填未接线」的红点、要给入参映射列出候选键，就必须拿到这一层语义。
 *
 * 三个数据源，各自的权威方不同：
 *   fixedSteps   平台受审词表（worker 侧 flowcheck/catalog）—— 平台承诺
 *   scripts      本工程 plugin.json 的 scripts[].io —— 插件自己声明
 *   triggerSeeds 五轴各自能播上黑板的键（worker 侧 trigger 词表）—— 平台承诺
 *
 * ⚠️ 受审词表在 worker 仓是 Go 源码，本仓拿不到编译产物，故此处是**手抄快照**。
 * 抄错的后果不是运行期故障（运行期以 worker 为准），而是画布少画/多画一条红线。
 * 改它要对着 worker 的 catalog 词表逐条核；CATALOG_SOURCE_REVISION 记录对账基准。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { CatalogSource, PlatformCatalog } from '../../contracts/knowledge.js'
import { resolveRuntimeProfile } from '../../services/application/runtime-profile.js'
import { resolveWorkspacePath } from '../../services/ide/files.js'
import type { AdaptedCatalog } from './knowledge-catalog.js'
import { adaptPlatformCatalog } from './knowledge-catalog.js'

/** 手抄自 worker 的哪一版。对账时先比这个串，不同就说明两边可能已漂移。 */
export const CATALOG_SOURCE_REVISION = 'platform-workflow-worker@flowcheck/catalog 2026-09-16'

/** 与 worker 的 flowcheck.Field 同形（type 取值见 worker 词表注释）。 */
export interface ActionField {
  readonly name: string;
  readonly type: string;
  /** 发布期必须接上：没接就是断链（flowcheck 的 R1）。 */
  readonly required?: boolean;
  /**
   * 出参语义：`''`/缺省 = 每次都产；`dynamic` / `signal` = 这次不一定产。
   * 画布据此把下游引用标成「需 when 守护」的黄标。
   */
  readonly from?: string;
  /** 嵌套成员：object 是本对象的成员，array 是元素的成员。 */
  readonly fields?: readonly ActionField[];
}

export interface FixedStepSpec {
  readonly action: string;
  /** 面向插件开发者的中文名；缺省时界面回落显示机器 action。 */
  readonly displayName?: string;
  readonly capability?: string;
  /** 下发飞行意图的步（画布给红色警示徽标）。 */
  readonly isFlight?: boolean;
  /** `activity` = 跑 activity；`await_signal` = 等信号，不跑 activity。 */
  readonly kind: 'activity' | 'await_signal';
  readonly owner: 'platform' | 'plugin';
  /** 重发会在下游多产生一份副作用，worker 侧配 MaximumAttempts=1。 */
  readonly nonIdempotent?: boolean;
  readonly inputs: readonly ActionField[];
  readonly outputs: readonly ActionField[];
  readonly description?: string;
}

export interface ScriptSpec {
  readonly id: string;
  readonly entry?: string;
  /** 清单里原样的 path —— **相对清单所在目录**（worker 就是这么解的）。 */
  readonly path?: string;
  /**
   * 同一份脚本的**工作区相对路径**，可直接喂给 `GET/PUT /api/file`。
   *
   * ⚠️ 与 `path` 分成两个字段而不是就地改写：`path` 是清单内容，改写它会让前端
   * 把工作区路径写回清单，而 worker 按清单目录解析，那会指到不存在的地方。
   * 两个消费者要的是两个不同的东西，各给各的。
   */
  readonly filePath?: string;
  readonly allowlist: readonly string[];
  readonly inputs: readonly ActionField[];
  readonly outputs: readonly ActionField[];
  readonly description?: string;
}

export interface TriggerSeedSpec {
  /** 这一轴可以播上黑板的键全集。 */
  readonly available: readonly string[];
  /** 其中「声明了也可能不播」的那些：引用它们的必填入参要 warn。 */
  readonly notGuaranteed: readonly string[];
  /** 平台已知键的值类型（同 core 的 TriggerSeedSpec.types ★）。 */
  readonly types?: Readonly<Record<string, string>>;
}

export interface IdeActionsData {
  readonly fixedSteps: readonly FixedStepSpec[];
  readonly scripts: readonly ScriptSpec[];
  readonly triggerSeeds: Readonly<Record<string, TriggerSeedSpec>>;
  /** `run.*` 根上的键（worker 的 flowcheck.runRoot，闭合根）。 */
  readonly runRoot: readonly string[];
  /** 动态脚本步的固定 action 名（worker 的 flowcheck.runScriptAction）。 */
  readonly scriptAction: string;
  /** 插件自定义能力的命名空间前缀（worker 的 flow.PluginActionPrefix）。 */
  readonly pluginActionPrefix: string;
  /** `steps.<id>.$state` 的全部取值（worker 的 flow 五个 State* 常量）。 */
  readonly stepStates: readonly string[];
  /** `when` 的合法算子（worker 的 flowcheck.validOps）。 */
  readonly conditionOps: readonly string[];
  /** `FlowStep.trigger` 的取值（留空 = allSucceeded）。 */
  readonly stepTriggers: readonly string[];
  /** 平台可授予脚本的能力名（worker 的 script.GrantableCaps）。 */
  readonly grantableCaps: readonly string[];
  /** 一个 I/O 字段的 type 能取哪些值（worker 的 flow.Type*）。 */
  readonly ioFieldTypes: readonly string[];
  /** 读 scripts[] 时是否真的找到了 plugin.json；false 时 scripts 为空数组。 */
  readonly pluginManifestFound: boolean;
  /** 后端清单的工作区相对路径（画布新建脚本要写回它）；没找到时缺省。 */
  readonly pluginManifestPath?: string;
  /**
   * 后端工程的语言档案（P0-1）：TS 工程新建 `.ts` 命名导出，JS 工程新建 goja ES5.1 `.js`。
   * 判定走 Runtime Profile（S1b），与构建器消费的同一份事实。
   */
  readonly scriptLanguage: 'typescript' | 'javascript';
  readonly catalogRevision: string;
  /**
   * 这份 Catalog 从哪来 —— **界面必须据此区分**「与 worker 版本绑定的事实」
   * 与「可能已漂移的内建手抄快照」。两者显示成一个样子就是假绿灯。
   */
  readonly catalogSource: CatalogSource;
}

function input (name: string, type: string, required = false): ActionField {
  return required ? { name, type, required } : { name, type }
}

function output (name: string, type: string, from?: string): ActionField {
  return from === undefined ? { name, type } : { name, type, from }
}

/**
 * 平台受审词表快照。只列 worker 里**有真实实现、现在跑的**步。
 *
 * 刻意不含 `*_test` 五条空转步：它们是 worker 自己验证编排用的，
 * 放进画布的节点菜单只会让插件作者以为那是可用能力。
 * 也不含 `run_script`：它的 I/O 因脚本而异，由 scripts[] 动态解引用（见 §3.2）。
 */
const FIXED_STEPS: readonly FixedStepSpec[] = [
  {
    action: 'dispatch_mission',
    displayName: '下发飞行任务',
    capability: 'device.mission:execute',
    isFlight: true,
    kind: 'activity',
    owner: 'platform',
    nonIdempotent: true,
    description: '下发飞行意图（过 Guard）。重发可能多创建一条飞行计划，worker 侧不重试。',
    inputs: [
      input('lat', 'number'),
      input('lng', 'number'),
      input('waylineUuid', 'id', true),
      input('dockSn', 'id', true),
      input('projectUuid', 'id', true),
      input('recordId', 'id'),
    ],
    outputs: [
      output('allowed', 'bool'),
      output('reasons', 'array'),
      output('droneId', 'id'),
      output('missionId', 'id'),
    ],
  },
  {
    action: 'query_flight_task',
    displayName: '查询飞行任务',
    capability: 'flight_task.detail:read',
    kind: 'activity',
    owner: 'platform',
    description: '查飞行计划详情（只读、不飞）。给 untilStatusIn 则轮询到终态。',
    inputs: [
      input('missionId', 'id', true),
      input('untilStatusIn', 'array'),
      input('everySec', 'number'),
    ],
    outputs: [
      output('taskStatus', 'number'),
      output('taskName', 'string'),
      output('taskType', 'number'),
      output('beginAt', 'timestamp'),
      output('endAt', 'timestamp'),
      output('workflowUuid', 'id'),
      output('currentWaypointIndex', 'number'),
      output('totalWaypoints', 'number'),
      output('exceptions', 'array'),
      // 只在轮询超时那一次产出 —— 下游引它必须有 when 守护。
      output('pollTimedOut', 'bool', 'dynamic'),
    ],
  },
  {
    action: 'spawn_agent',
    displayName: '拉起巡逻容器',
    capability: 'agent.session:create',
    kind: 'activity',
    owner: 'platform',
    nonIdempotent: true,
    description: '起巡逻容器并抢控。五个入参全必填（下游 binding:required）。',
    inputs: [
      input('taskUuid', 'id', true),
      input('projectUuid', 'id', true),
      input('dockSn', 'id', true),
      input('waylineUuid', 'id', true),
      input('flightId', 'id', true),
    ],
    outputs: [
      output('sessionId', 'id'),
      output('droneSn', 'id'),
      output('containerName', 'string'),
      output('drcAcquired', 'bool'),
      output('skipped', 'bool'),
      output('skipReason', 'string'),
    ],
  },
  {
    action: 'return_home',
    displayName: '命令返航',
    capability: 'device.flight:return_home',
    kind: 'activity',
    owner: 'platform',
    nonIdempotent: true,
    description: '命令返航。只有 sessionId 必填，下游按会话行找项目与设备。',
    inputs: [
      input('sessionId', 'id', true),
      input('flightId', 'id'),
      input('dockSn', 'id'),
    ],
    outputs: [
      output('accepted', 'bool'),
      output('controlReleased', 'bool'),
    ],
  },
  {
    action: 'update_event_status',
    displayName: '回写事件状态',
    kind: 'activity',
    owner: 'platform',
    description: '回写统一事件模型里那条事件的处置状态。status 必须是 const（编排语义）。',
    inputs: [
      input('status', 'enum', true),
      input('eventId', 'id'),
      input('flightMissionId', 'id'),
    ],
    outputs: [output('eventStatus', 'enum')],
  },
  {
    action: 'wait_signal',
    displayName: '等待人工信号',
    kind: 'await_signal',
    owner: 'platform',
    description: '挂起等人在环信号。出参由 await.provides / optional 逐流程声明。',
    inputs: [],
    outputs: [],
  },
]

/**
 * 五轴各自能播上黑板的键。
 *
 * ⚠️ `api` 与 `job` 两轴的 available 是**空数组且语义不同**：那两轴的 seed 由流程作者
 * 自己在 trigger 段声明（键名自定），不像 stream / bizNotify 有一张平台固定的映射表。
 * 画布对这两轴要让用户自由填 seed 键名，而不是从下拉里选。
 */
const TRIGGER_SEEDS: Readonly<Record<string, TriggerSeedSpec>> = {
  api: { available: [], notGuaranteed: [] },
  job: { available: [], notGuaranteed: [] },
  schedule: { available: [], notGuaranteed: [] },
  stream: {
    // worker 的 trigger.seedable()：映射表的黑板键 + 两个派生坐标键
    available: [
      'eventId',
      'eventType',
      'tenantId',
      'source',
      'status',
      'priority',
      'occurredAt',
      'flightMissionId',
      'resultCode',
      'notifyOn',
      'payload',
      'lat',
      'lng',
    ],
    // worker 的 trigger.notGuaranteed：坐标两个都非零才播；未关联任务时 flightMissionId 是空串
    notGuaranteed: ['lat', 'lng', 'flightMissionId'],
    // 手抄 worker 的 trigger.StreamSeed() 运行期事实（stream.go 的纪律 2/3）：
    // flat 字段一律原样当字符串播；payload 播解析后的对象；lat/lng 播 poi 解出的数。
    types: {
      eventId: 'string',
      eventType: 'string',
      tenantId: 'string',
      source: 'string',
      status: 'string',
      priority: 'string',
      occurredAt: 'string',
      flightMissionId: 'string',
      resultCode: 'string',
      notifyOn: 'string',
      payload: 'object',
      lat: 'number',
      lng: 'number',
    },
  },
  bizNotify: {
    // worker 的 trigger.bizSeedable()
    available: [
      'eventId',
      'eventKind',
      'occurredAt',
      'taskUuid',
      'projectUuid',
      'taskName',
      'taskType',
      'dockSn',
      'droneSn',
      'waylineUuid',
      'taskStatus',
    ],
    // worker 的 trigger.bizNotGuaranteed：上游 TaskBrief 里这几项都可能是空串
    notGuaranteed: ['taskName', 'dockSn', 'droneSn', 'waylineUuid'],
    // 手抄 worker 的 trigger.BizSeed() 运行期事实（biznotify.go + bizevent）：
    // 标识类是字符串；occurredAt 是 Unix 秒时间戳（int64），taskType/taskStatus 是整数。
    types: {
      eventId: 'string',
      eventKind: 'string',
      occurredAt: 'number',
      taskUuid: 'string',
      projectUuid: 'string',
      taskName: 'string',
      taskType: 'number',
      dockSn: 'string',
      droneSn: 'string',
      waylineUuid: 'string',
      taskStatus: 'number',
    },
  },
}

/** worker 的 script.grantableCaps —— 平台此刻真授得出的能力名。 */
const GRANTABLE_CAPS: readonly string[] = [
  'cache:read',
  'cache:write',
  'config:get',
  'data:read',
  'data:write',
  'egress:fetch',
  'event:write',
  'flow:start',
  'geo.segment:read',
  'integration.gis:read',
  'integration:write',
  'media:read',
  'media:write',
  'notify:publish',
  'screenshot:issueupload',
  'screenshot:signurl',
  'track:read',
  'video:process',
  'wayline:generate',
]

/** worker 的 flowcheck.runRoot —— 闭合根，指到表外的键一律 error。 */
const RUN_ROOT: readonly string[] = ['now', 'idempotencyKey', 'intervalSec']

/** worker 的 flow 五个 State* 常量（steps.<id>.$state 的全部取值）。 */
const STEP_STATES: readonly string[] = ['succeeded', 'failed', 'skipped', 'timedOut', 'interrupted']

/** worker 的 flowcheck.validOps —— 与 flow.EvalCondition 实际支持的算子集一致。 */
const CONDITION_OPS: readonly string[] = ['eq', 'ne', 'in', 'exists', 'blank', 'present']

const STEP_TRIGGERS: readonly string[] = ['allSucceeded', 'allDone']

/**
 * worker 的 flow.Type* 五常量 —— 一个 I/O 字段的 `type` 能取的全部值。
 *
 * ⚠️ 这是**内建手抄快照**的那一份，只在没固定知识包时用。固定了知识包时取
 * `language.json` 的 `providedTypes`（见 knowledge-catalog 的 ioFieldTypes ★★）。
 */
const IO_FIELD_TYPES: readonly string[] = ['string', 'number', 'bool', 'object', 'array']

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 后端源目录（遗留布局的 .ts 证据只看这些 —— src/ 是前端的，不算数）。 */
const BACKEND_SOURCE_DIRS: readonly string[] = ['adapters', 'handlers', 'shared', 'events']

function hasTsSource (directory: string): boolean {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .some(entry => entry.isFile() && entry.name.endsWith('.ts'))
  } catch {
    return false
  }
}

/**
 * 后端工程的语言档案（P0-1）：清单挂在哪个后端工程下，就按那个工程的
 * Runtime Profile（S1b）判定。与构建器消费的是**同一份事实**：
 *   typescript → 构建器经 esbuild 打包 adapters 目录下的 .ts（命名导出）
 *   javascript → 脚本按清单 path 原样装载（goja ES5.1）
 *
 * 判定顺序：
 *   ① Runtime Profile 的后端成员（capability 工程按 workflow 归属命中）；
 *   ② 清单自己 scripts[] 已用的扩展名 —— 最直接的证据（前后端同根的混合工程
 *      没有后端成员可命中，此时不能扫整个根目录：前端 src/ 的 .ts 会被误认）；
 *   ③ 遗留空清单：只扫后端源目录（adapters/handlers/shared/events）里有没有 .ts。
 */
export function resolveScriptLanguage (root: string, manifestPath: string | undefined): 'typescript' | 'javascript' {
  if (manifestPath === undefined || manifestPath === '') return 'javascript'
  try {
    const profile = resolveRuntimeProfile(root)
    const projectRoot = resolve(root, dirname(manifestPath))
    const backend = profile.backend.find(item => item.root === projectRoot)
    if (backend !== undefined) return backend.sourceLanguage
  } catch {
    // 损坏工程按下面的证据判，不给画布一个假的语言档案。
  }
  const manifest = readWorkspaceScripts(root, manifestPath)
  if (manifest.scripts.length > 0) {
    return manifest.scripts.some(script => script.path?.endsWith('.ts') === true)
      ? 'typescript'
      : 'javascript'
  }
  const manifestDir = dirname(manifestPath)
  return BACKEND_SOURCE_DIRS.some(dir => hasTsSource(join(root, manifestDir, dir)))
    ? 'typescript'
    : 'javascript'
}

/** 把 plugin.json 的 io 字段收成 ActionField[]；形状不对就当空（宁可少画红线，不误报）。 */function toFields (value: unknown): ActionField[] {
  if (!Array.isArray(value)) return []
  const fields: ActionField[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = item.name
    const type = item.type
    if (typeof name !== 'string' || name === '' || typeof type !== 'string') continue
    const nested = toFields(item.fields)
    fields.push({
      name,
      type,
      ...(item.required === true ? { required: true } : {}),
      ...(nested.length > 0 ? { fields: nested } : {}),
    })
  }
  return fields
}

/**
 * 后端源码清单的候选位置。
 *
 * 两种工程布局都要覆盖：capability 工程把后端放在 `backend/`，纯后端插件工程
 * 直接放在根。顺序即优先级，取第一个存在的。
 *
 * 源码清单已统一命名为 `fh2-plugin.json`（与前端一致）；`plugin.json` 仅保留
 * 兼容旧工程。dist 产物清单仍固定为 `plugin.json`（Worker 契约冻结），与本表无关。
 */
const PLUGIN_MANIFEST_CANDIDATES: readonly string[] = [
  'backend/fh2-plugin.json',
  'fh2-plugin.json',
  'backend/plugin.json',
  'plugin.json',
]

/** 根据 Workflow 文件归属选择后端，禁止把其他成员的脚本混入本流程。 */
export function resolveWorkflowManifest (root: string, workflowPath?: string): string | undefined {
  if (workflowPath !== undefined) {
    const target = resolveWorkspacePath(root, workflowPath)
    let directory = dirname(target.absolutePath)
    const boundary = resolve(root)
    while (directory === boundary || directory.startsWith(`${boundary}${sep}`)) {
      for (const name of ['fh2-plugin.json', 'plugin.json']) {
        const file = join(directory, name)
        if (!existsSync(file)) continue
        try {
          const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
          if (typeof manifest.pluginId === 'string') return relative(boundary, file).split(sep).join('/')
        } catch {
          return undefined
        }
      }
      if (directory === boundary) break
      directory = dirname(directory)
    }
    return undefined
  }
  try {
    const profile = resolveRuntimeProfile(root)
    if (profile.backend.length === 1) {
      const backend = profile.backend[0]!.root
      const name = ['fh2-plugin.json', 'plugin.json'].find(name => existsSync(join(backend, name)))
      if (name) return relative(root, join(backend, name)).split(sep).join('/')
    }
    if (profile.backend.length > 1) return undefined
  } catch { /* 损坏工程仍返回平台 Catalog。 */ }
  // 独立旧工程的兼容读取；有路径上下文时不使用全局候选。
  return PLUGIN_MANIFEST_CANDIDATES.find((candidate) => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, candidate), 'utf8')) as Record<string, unknown>
      return typeof manifest.pluginId === 'string'
    } catch {
      return false
    }
  })
}

/** 从工作根读后端源码清单的 scripts[]，解出每份脚本的 I/O 契约。 */
export function readWorkspaceScripts (root: string, workflowPath?: string): {
  readonly scripts: ScriptSpec[];
  readonly found: boolean;
  /** 清单自身的工作区相对路径（画布要写回它）。 */
  readonly manifestPath?: string;
} {
  const relative = resolveWorkflowManifest(root, workflowPath)
  if (relative === undefined) return { scripts: [], found: false }
  const file = join(root, relative)

  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    // plugin.json 正被编辑成半截 JSON 是常态；画布这时少一批脚本候选即可，不该 500。
    return { scripts: [], found: false, manifestPath: relative }
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.scripts)) {
    return { scripts: [], found: true, manifestPath: relative }
  }

  // 清单所在目录：scripts[].path 相对它，而 /api/file 要的是相对工作根。
  const manifestDir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''

  const scripts: ScriptSpec[] = []
  for (const entry of manifest.scripts) {
    if (!isRecord(entry)) continue
    // 寻址键是 name（worker 的 Script.ID / Key()），不是 path。
    const id = typeof entry.name === 'string' ? entry.name : ''
    if (id === '') continue
    const io = isRecord(entry.io) ? entry.io : {}
    const path = typeof entry.path === 'string' ? entry.path : undefined
    scripts.push({
      id,
      ...(typeof entry.entry === 'string' ? { entry: entry.entry } : {}),
      ...(path === undefined ? {} : { path, filePath: joinWorkspacePath(manifestDir, path) }),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      allowlist: stringArray(entry.allowlist),
      inputs: toFields(io.inputs),
      outputs: toFields(io.outputs),
    })
  }
  return { scripts, found: true, manifestPath: relative }
}

/** 把「清单目录 + 清单内的相对 path」拼成工作区相对路径。 */
function joinWorkspacePath (directory: string, path: string): string {
  if (directory === '') return path
  return `${directory}/${path}`
}

export interface ResolveIdeActionsOptions {
  readonly root: string;
  readonly workflowPath?: string;
}

/**
 * 组装 `GET /api/actions` 的回包。
 *
 * ★★ 数据来源有两条，**回包里必须说清是哪一条**（`catalogSource`）：
 *   ① 项目固定了知识包且能解析 → 平台契约来自那份知识，与 worker revision 绑定
 *   ② 未固定 / 解析失败        → 回退到本文件的手抄快照，并带上原因
 *
 * ⚠️ 回退不是容错，是**显式状态**。计划 §52 明确：Knowledge v1 Ready 之前不能删手抄
 * Catalog；但把两种来源显示成同一个样子，等于把「可能已漂移的手抄」冒充成事实。
 * 故这里宁可多一个字段，也不让前端猜。
 *
 * ⓘ 本函数是同步的（画布每次切文件都调它），而知识解析要读盘。故知识那一路由
 * 调用方预先解析好后经 `platformCatalog` 传进来 —— 本文件不自己 await。
 */
export function resolveIdeActions (options: ResolveIdeActionsOptions & {
  /** 已解析的平台 Catalog；缺省则回退到内建手抄快照。 */
  readonly platformCatalog?: PlatformCatalog;
  /** 没用上知识包的原因（回退时填，进回包供界面显示）。 */
  readonly fallbackReason?: string;
}): IdeActionsData {
  const { scripts, found, manifestPath } = readWorkspaceScripts(options.root, options.workflowPath)

  let platform: AdaptedCatalog | undefined
  let source: CatalogSource
  if (options.platformCatalog !== undefined) {
    try {
      platform = adaptPlatformCatalog(options.platformCatalog)
      source = options.platformCatalog.source
    } catch (error) {
      // 知识包在，但翻不成画布语义。这属于生产/消费口径不一致，必须说出来而不是静默回退。
      platform = undefined
      source = {
        kind: 'builtin-snapshot',
        revision: CATALOG_SOURCE_REVISION,
        reason: `知识 Catalog 无法适配画布语义，已回退到内建快照：${(error as Error).message}`,
      }
    }
  } else {
    source = {
      kind: 'builtin-snapshot',
      revision: CATALOG_SOURCE_REVISION,
      ...(options.fallbackReason === undefined ? {} : { reason: options.fallbackReason }),
    }
  }

  return {
    fixedSteps: platform?.fixedSteps ?? FIXED_STEPS,
    scripts,
    triggerSeeds: platform?.triggerSeeds ?? TRIGGER_SEEDS,
    runRoot: platform?.vocabulary.runRoot ?? RUN_ROOT,
    scriptAction: platform?.scriptAction ?? 'run_script',
    pluginActionPrefix: platform?.vocabulary.pluginActionPrefix ?? 'plugin.',
    stepStates: platform?.vocabulary.stepStates ?? STEP_STATES,
    conditionOps: platform?.vocabulary.conditionOps ?? CONDITION_OPS,
    stepTriggers: platform?.vocabulary.stepTriggers ?? STEP_TRIGGERS,
    grantableCaps: platform?.grantableCaps ?? GRANTABLE_CAPS,
    ioFieldTypes: platform?.vocabulary.ioFieldTypes ?? IO_FIELD_TYPES,
    pluginManifestFound: found,
    ...(manifestPath === undefined ? {} : { pluginManifestPath: manifestPath }),
    scriptLanguage: resolveScriptLanguage(options.root, manifestPath),
    catalogRevision: source.kind === 'knowledge' ? source.revision : CATALOG_SOURCE_REVISION,
    catalogSource: source,
  }
}
