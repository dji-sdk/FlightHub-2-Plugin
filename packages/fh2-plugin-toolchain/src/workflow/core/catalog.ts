// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * 受审词表（`GET /api/actions`）在前端的类型与查询。
 *
 * 契约 §9：「节点类型与连线合法性由知识层约束，画布不自创规则」。
 * 本模块只做**读取与索引**，一条规则都不发明：词表里没有的 action，画布就当它是
 * 「未受审的自由 action」，而不是猜一套入参出来。
 */

// contracts 是 browser-safe 的纯类型模块（见 contracts/browser-safe.test.ts），
// 从这里 import 不破坏本模块的 browser-safe 约束。
import type { CatalogSource } from '../../contracts/knowledge.js'

export type { CatalogSource }

/**
 * 受审词表数据（`GET /api/actions` 的 IdeActionsData 同构形状）。
 * 自包含定义：本模块必须保持 browser-safe（IDE 经内部相对路径直接消费），
 * 不得引入 serve / Node 依赖。
 */
export interface ActionsCatalogData {
  readonly fixedSteps: readonly FixedStepSpec[];
  readonly scripts: readonly ScriptSpec[];
  readonly triggerSeeds: Readonly<Record<string, TriggerSeedSpec>>;
  readonly runRoot: readonly string[];
  readonly scriptAction: string;
  readonly pluginActionPrefix: string;
  readonly stepStates: readonly string[];
  readonly conditionOps: readonly string[];
  readonly stepTriggers: readonly string[];
  readonly grantableCaps: readonly string[];
  /**
   * 一个 I/O 字段的 `type` 能取哪些值。
   *
   * 可缺省：老服务端不发这一项。缺省时归一成空表，而空表 = **不判 type**
   * —— 见 ActionCatalog.ioFieldTypes 的 ★★。
   */
  readonly ioFieldTypes?: readonly string[];
  readonly pluginManifestFound: boolean;
  readonly pluginManifestPath?: string;
  /**
   * 后端工程的语言档案（P0-1）：决定「新建业务功能」的默认扩展名与源码形态。
   * 老服务端不发这一项 → 按 javascript（goja ES5.1）。
   */
  readonly scriptLanguage?: 'typescript' | 'javascript';
  readonly catalogSource: CatalogSource;
}

export interface ActionField {
  readonly name: string;
  readonly type: string;
  readonly required?: boolean;
  /** `dynamic` / `signal` = 这次不一定产出，下游引用需 when 守护。 */
  readonly from?: string;
  readonly fields?: readonly ActionField[];
}

export interface FixedStepSpec {
  readonly action: string;
  /**
   * 面向插件开发者的中文名（P1-1：主标题用业务语言，机器 action 作副标题）。
   * 由词表数据携带 —— UI 组件不维护手抄映射。知识包未提供时缺省，
   * 界面回落显示机器 action。
   */
  readonly displayName?: string;
  readonly capability?: string;
  readonly isFlight?: boolean;
  readonly kind: 'activity' | 'await_signal';
  readonly owner: 'platform' | 'plugin';
  readonly nonIdempotent?: boolean;
  readonly inputs: readonly ActionField[];
  readonly outputs: readonly ActionField[];
  readonly description?: string;
}

export interface ScriptSpec {
  readonly id: string;
  readonly entry?: string;
  /** 清单里原样的 path（相对清单所在目录）—— 写回清单用这个。 */
  readonly path?: string;
  /** 工作区相对路径 —— 读写那份 .js 用这个（见 serve/actions.ts 的说明）。 */
  readonly filePath?: string;
  readonly allowlist: readonly string[];
  readonly inputs: readonly ActionField[];
  readonly outputs: readonly ActionField[];
  readonly description?: string;
}

export interface TriggerSeedSpec {
  readonly available: readonly string[];
  readonly notGuaranteed: readonly string[];
  /**
   * 平台已知键的值类型（键 → ioFieldTypes 词表里的类型名）。
   *
   * ★ 只在平台**承诺得出**时有值：stream / bizNotify 的固定键由 worker 运行期
   * 代码决定类型；api / job 的键由作者自定、值装载期不可知 → 没有这张表。
   * 知识包还没带 seedTypes 时也为空 —— 界面展示为「不带类型」，不猜。
   */
  readonly types?: Readonly<Record<string, string>>;
}

/**
 * 词表在前端的索引形态。
 *
 * `available` 为 false 表示 `/api/actions` 没取到：此时画布必须**降级**成
 * 「不校验入参、action 自由输入」，而不是把所有节点都标成红 ——
 * 取不到词表是环境问题，不是用户的流程写错了。
 */
export interface ActionCatalog {
  readonly available: boolean;
  readonly fixedSteps: readonly FixedStepSpec[];
  readonly scripts: readonly ScriptSpec[];
  readonly triggerSeeds: Readonly<Record<string, TriggerSeedSpec>>;
  readonly runRoot: readonly string[];
  readonly scriptAction: string;
  readonly pluginActionPrefix: string;
  readonly stepStates: readonly string[];
  readonly conditionOps: readonly string[];
  readonly stepTriggers: readonly string[];
  readonly grantableCaps: readonly string[];
  /**
   * 一个 I/O 字段的 `type` 能取哪些值（清单 `scripts[].io.*[].type`）。
   *
   * ★★ 空表 = 「这一刻没有可依的词表」，此时**一律不判** type，而不是回落到画布
   * 自带的一份枚举。理由在 worker 侧：`flow.TypeOK` 对词表外的类型名**恒真** ——
   * 拼错的 `bolean` 不会报错，只会让那个字段从此不做类型校验。画布若拿一份可能
   * 已漂移的枚举去拒，拒掉的是**合法**声明；而不判只是少拦一次拼写错。
   */
  readonly ioFieldTypes: readonly string[];
  readonly pluginManifestFound: boolean;
  /** 后端清单的工作区相对路径；没找到时为空串。 */
  readonly pluginManifestPath: string;
  /** 后端工程语言档案；决定新建脚本的扩展名与模板形态。 */
  readonly scriptLanguage: 'typescript' | 'javascript';
  /**
   * 这份词表从哪来。**界面必须显示它**（计划 §11.9）：
   * `builtin-snapshot` 是 Toolchain 内建手抄快照，可能与目标 worker 版本已漂移；
   * `knowledge` 才是与某个 workerRevision 绑定的事实。
   */
  readonly source: CatalogSource;
}

/** 词表取不到时的保守空值：available=false 驱动 UI 降级。 */
export const EMPTY_CATALOG: ActionCatalog = {
  available: false,
  // 词表取不到时来源同样「取不到」。刻意不写成 knowledge：
  // available=false 的空词表若声称来自知识包，界面会显示一个自信的空菜单。
  source: { kind: 'builtin-snapshot', revision: '(未取到)', reason: '平台动作目录请求失败' },
  fixedSteps: [],
  scripts: [],
  triggerSeeds: {},
  runRoot: [],
  scriptAction: 'run_script',
  pluginActionPrefix: 'plugin.',
  stepStates: [],
  conditionOps: [],
  stepTriggers: [],
  grantableCaps: [],
  ioFieldTypes: [],
  pluginManifestFound: false,
  pluginManifestPath: '',
  scriptLanguage: 'javascript',
}

export function toCatalog (result: ActionsCatalogData): ActionCatalog {
  return {
    available: true,
    fixedSteps: result.fixedSteps,
    scripts: result.scripts,
    triggerSeeds: result.triggerSeeds,
    runRoot: result.runRoot,
    scriptAction: result.scriptAction,
    pluginActionPrefix: result.pluginActionPrefix,
    stepStates: result.stepStates,
    conditionOps: result.conditionOps,
    stepTriggers: result.stepTriggers,
    grantableCaps: result.grantableCaps,
    // 老服务端没有这一项 → 空表 → 不判 type（见 ActionCatalog.ioFieldTypes ★★）。
    ioFieldTypes: result.ioFieldTypes ?? [],
    pluginManifestFound: result.pluginManifestFound,
    pluginManifestPath: result.pluginManifestPath ?? '',
    scriptLanguage: result.scriptLanguage ?? 'javascript',
    source: result.catalogSource,
  }
}

export function findFixedStep (catalog: ActionCatalog, action: string): FixedStepSpec | undefined {
  return catalog.fixedSteps.find(step => step.action === action)
}

export function findScript (catalog: ActionCatalog, id: string): ScriptSpec | undefined {
  return catalog.scripts.find(script => script.id === id)
}

/** 插件自定义能力（`plugin.<名>`）：运行期可分派，但不在平台词表内。 */
export function isPluginAction (catalog: ActionCatalog, action: string): boolean {
  return action.startsWith(catalog.pluginActionPrefix) && action.length > catalog.pluginActionPrefix.length
}

/**
 * `run_script` 的两个步级元入参。
 *
 * 它们不在脚本自己的 io.inputs 里，但**必须写在流程 JSON 上**，
 * 否则会被「声明之外的入参名」判成错（worker 的 flowcheck.stepIO 就是这么拼的）。
 */
export const SCRIPT_META_INPUTS: readonly ActionField[] = [
  { name: 'script', type: 'string', required: true },
  { name: 'connectorId', type: 'string' },
]

/**
 * 平台内部约定的保留键，不许当业务入参递给脚本（worker 的 script.addressingKeys）。
 * `now` / `idempotencyKey` 经 ctx 给脚本，在 input 里再出现一份会互相覆盖。
 */
export const SCRIPT_RESERVED_INPUT_KEYS: readonly string[] = ['script', 'now', 'idempotencyKey']

export interface StepIO {
  readonly inputs: readonly ActionField[];
  readonly outputs: readonly ActionField[];
  /** 词表/脚本里查得到这一步的 I/O 吗。false 时校验器必须放行（不可误报）。 */
  readonly resolved: boolean;
  /** 这一步是不是 run_script。 */
  readonly isScript: boolean;
  /** run_script 引用的脚本 id（从 inputs.script 的 const 取）。 */
  readonly scriptId?: string;
  /** 引用了脚本 id 但词表里没有这份脚本 —— 脚本升版改名或拼错。 */
  readonly scriptMissing?: boolean;
}

const UNRESOLVED: StepIO = { inputs: [], outputs: [], resolved: false, isScript: false }

/**
 * 解一步的 I/O 声明，对齐 worker 的 `flowcheck.stepIO`：
 * `run_script` 按 `inputs.script` 解引用脚本契约（并补两个元入参），否则查受审词表。
 */
export function resolveStepIO (
  catalog: ActionCatalog,
  action: string,
  scriptId: string | undefined,
): StepIO {
  if (!catalog.available) return UNRESOLVED

  if (action === catalog.scriptAction) {
    if (scriptId === undefined || scriptId === '') {
      // 还没选脚本：只有两个元入参是确定的，出参未知。
      return { inputs: SCRIPT_META_INPUTS, outputs: [], resolved: true, isScript: true }
    }
    const script = findScript(catalog, scriptId)
    if (script === undefined) {
      return {
        inputs: SCRIPT_META_INPUTS,
        outputs: [],
        resolved: true,
        isScript: true,
        scriptId,
        scriptMissing: true,
      }
    }
    return {
      inputs: [...script.inputs, ...SCRIPT_META_INPUTS],
      outputs: script.outputs,
      resolved: true,
      isScript: true,
      scriptId,
    }
  }

  const fixed = findFixedStep(catalog, action)
  if (fixed === undefined) return UNRESOLVED
  return { inputs: fixed.inputs, outputs: fixed.outputs, resolved: true, isScript: false }
}
