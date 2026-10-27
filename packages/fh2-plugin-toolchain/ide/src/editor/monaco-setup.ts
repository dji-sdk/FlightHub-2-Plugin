// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import * as monaco from 'monaco-editor'
import { ref } from 'vue'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { LanguageIdEnum, setupLanguageFeatures } from 'monaco-sql-languages'
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution'
import PgSqlWorker from 'monaco-sql-languages/esm/languages/pgsql/pgsql.worker?worker'
import type { SchemaEntry } from '../api/types.js'

/**
 * Monaco 语言 worker 的后台健康状态：任一 worker 脚本加载/执行失败时置 true。
 * 语义是「校验/补全后台降级」——编辑不受影响，但用户必须看得见：
 * 静默失去 JSON Schema 校验会让人误以为校验通过了（IDE-013-07）。
 * Worker 脚本按需拉取（打开对应语言文件才建 worker），所以失败发生在会话中途也一样可见。
 */
export const monacoWorkerFailed = ref(false)

/** 绑定 worker 错误监听（导出供单测：fake worker 验证置位）。 */
export function monitorWorkerHealth (worker: { addEventListener?: (type: 'error', listener: (event: ErrorEvent) => void) => void; onerror?: ((event: ErrorEvent) => void) | null }): void {
  const mark = (): void => {
    monacoWorkerFailed.value = true
  }
  if (typeof worker.addEventListener === 'function') worker.addEventListener('error', mark)
  else worker.onerror = mark
}

/**
 * Monaco 的 worker 必须由打包器产出真实 worker chunk；Vite 的 `?worker` 后缀即此用途。
 * 必须在 `monaco.editor.create` 之前装好，否则语言服务静默降级为纯高亮。
 *
 * 写 `window` 而不是 `self`：主线程里两者同一对象，但 `self` 被仓库的
 * `no-restricted-globals` 禁用，且 Monaco 的类型只在 `Window` 上声明了这个属性。
 */
export function installMonacoWorkers (): void {
  window.MonacoEnvironment = {
    getWorker (_workerId: string, label: string) {
      const worker = label === 'json'
        ? new JsonWorker()
        : label === 'typescript' || label === 'javascript'
          ? new TsWorker()
          : label === LanguageIdEnum.PG
            ? new PgSqlWorker()
            : new EditorWorker()
      monitorWorkerHealth(worker)
      return worker
    },
  }
}

/**
 * schema.sql 使用 PostgreSQL 方言，但最终只允许 Toolchain 定义的受控 DDL 子集。
 * 这里只开启通用关键字/snippet 补全；第三方 parser 对中文注释存在误报，不能作为诊断源。
 */
export function installPostgreSqlLanguageFeatures (): void {
  setupLanguageFeatures(LanguageIdEnum.PG, {
    completionItems: true,
    diagnostics: false,
    definitions: false,
    references: false,
    hover: false,
    format: false,
  })
}

/**
 * 最近一次应用到 jsonDefaults 的配置。null = 本会话还没 apply 过
 * （此时没有可重申的东西，「从未 apply」本身是待定位的根因，不在这里掩盖）。
 */
let lastAppliedJsonOptions: monaco.languages.json.DiagnosticsOptions | null = null
let jsonReassertScheduled = false

/** 契约 §2.7：schema 内联返回，因此必须关掉 enableSchemaRequest，Monaco 不去网络取。 */
export function applyJsonSchemas (schemas: readonly SchemaEntry[]): void {
  const options: monaco.languages.json.DiagnosticsOptions = {
    validate: true,
    enableSchemaRequest: false,
    allowComments: false,
    trailingCommas: 'error',
    schemaValidation: 'error',
    schemas: schemas.map(entry => ({
      uri: entry.uri,
      fileMatch: [...entry.fileMatch],
      schema: entry.schema,
    })),
  }
  lastAppliedJsonOptions = options
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions(options)
  // [fh2-diag] 低频诊断（DAG-013-01 根因定位）：schema 配置链路的可观测性。
  // info 级、每次 apply 一条，保留在产品里。
  // eslint-disable-next-line no-console -- 诊断日志（见上）
  console.info('[fh2-diag] json-schemas-applied', `count=${options.schemas?.length ?? 0}`)
  scheduleJsonSchemaReassert()
}

/**
 * ★ DAG-013-01 结构性防御：json worker 在创建时**快照**配置，之后的配置更新
 * 依赖 setDiagnosticsOptions 触发的 onDidChange → stopWorker → 下次请求重建。
 * 任何时序竞态下（worker 抢在配置链路前创建、onDidChange 消费者未就位时的
 * fire 被吞）schema 校验都会静默缺席——语法校验照常跑，用户以为校验通过了。
 * 这里在 apply 之后延迟重申一次**相同配置**：幂等（配置不变，只触发 worker
 * 重建链），且确保 defaults 的最新值一定被「已存在的」消费者看到。
 */
function scheduleJsonSchemaReassert (): void {
  if (jsonReassertScheduled) return
  jsonReassertScheduled = true
  window.setTimeout(() => {
    jsonReassertScheduled = false
    if (lastAppliedJsonOptions !== null) {
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions(lastAppliedJsonOptions)
      // eslint-disable-next-line no-console -- 诊断日志（见 applyJsonSchemas）
      console.info('[fh2-diag] json-schemas-reassert delayed=1s')
    }
  }, 1000)
}

/**
 * ★ DAG-013-01 防御的第二路：json 语言首次激活（= 第一个 json model 创建，
 * 触发 jsonMode 懒加载）时若已有应用过的配置，立即重申。monaco 0.52 的
 * onDidChange 消费者（WorkerManager / DiagnosticsAdapter）都由 setupMode 创建，
 * 此刻恰好即将就位——重申保证它们生下来看到的就是最新配置。
 */
export function reassertJsonSchemasOnLanguageActivation (): void {
  monaco.languages.onLanguage('json', () => {
    // [fh2-diag] ★ DAG-013-01 根因关键观测点：json 语言首次激活（第一个 json
    // model 创建、jsonMode 懒加载）的时刻，schema 配置是否已 apply。
    // hadConfig=false 意味着 worker 初始化链路早于配置就位。
    // eslint-disable-next-line no-console -- 诊断日志（见 applyJsonSchemas）
    console.info('[fh2-diag] json-language-activated', `hadConfig=${lastAppliedJsonOptions !== null}`)
    if (lastAppliedJsonOptions !== null) {
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions(lastAppliedJsonOptions)
      // eslint-disable-next-line no-console -- 诊断日志（见 applyJsonSchemas）
      console.info('[fh2-diag] json-schemas-reassert trigger=language-activation')
    }
  })
}

/** 仅测试用：清空防御状态，让用例之间互不耦合。 */
export function __resetJsonSchemaDefenseForTest (): void {
  lastAppliedJsonOptions = null
  jsonReassertScheduled = false
}

/**
 * handler 是 Goja 按名取的全局函数、`ctx` 由宿主注入，都不是 ESM 导出。
 * 这几条诊断在这种执行模型下恒为噪音，必须屏蔽，否则每个 handler 文件都一片红：
 *   2307 找不到模块 ／ 2580 找不到 require/module/exports
 *   7016 隐式 any 的 require ／ 80001 建议改成 ES module
 */
const GOJA_DIAGNOSTICS: monaco.languages.typescript.DiagnosticsOptions = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
  diagnosticCodesToIgnore: [2307, 2580, 7016, 80001],
}

/**
 * 后端插件脚本的运行时档（goja，实测校准 2026-09-22）：
 * ES2015 语法与同步集合全部可用 —— 箭头、模板串、class、生成器、解构、
 * for-of、Map/Set/Symbol、Object.assign 都在（worker 钉定的 goja 版本
 * 逐一验证过）；唯一的真约束是**没有事件循环**：Promise 对象存在但
 * `.then` 永不调度，async/await 经 esbuild（target es2015）降级后同样
 * 挂起，setTimeout 不存在。
 *
 * 因此这一档 = ES2015 全量**减 es2015.promise**：写 `new Promise(...).then`
 * 或 `async` 函数的地方当场「找不到名称 'Promise'」—— 那正是线上会挂起
 * 的地方；而 `new Map()` 不再吃 ES5 档时代的假红线。
 * target 对齐 esbuild 的 es2015（backend compiler 事实）；import 不报错
 * （2307 已在 GOJA_DIAGNOSTICS 里忽略 —— 入口文件带 import/export 时
 * 构建期自动切 esm-bundle 模式打平，.ts 恒走 bundle）。
 *
 * Monaco 的 TS defaults 是全局单例，无法按文件分档，因此只要工作区是后端插件
 * （或全栈插件里编辑 backend/ 下的脚本）就整体切到这一档。
 */
export function applyGojaTypeScriptDefaults (): void {
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ES2015,
    // es2015.promise 刻意不进（无事件循环）；es2015.proxy/reflect goja 未提供，不进
    lib: ['es5', 'es2015.core', 'es2015.symbol', 'es2015.collection', 'es2015.iterable', 'es2015.generator'],
    allowJs: true,
    // 必须开 checkJs：后端 handler 全是 .js，关掉它整档就只剩语法检查，
    // 上面的 lib 收窄形同虚设
    checkJs: true,
    noLib: false,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  }
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(GOJA_DIAGNOSTICS)
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(GOJA_DIAGNOSTICS)
}

/** 前端插件（浏览器 Realm）用仓库基线的 ES2022 + DOM。 */
export function applyBrowserTypeScriptDefaults (): void {
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    // monaco.d.ts 的 ScriptTarget 枚举停在 ES2020，而 worker 里的 TS 本身支持更高；
    // 用 ESNext 配 lib es2022 表达仓库基线，避免为枚举缺项去 cast。
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    lib: ['es2022', 'dom', 'dom.iterable'],
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
  }
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions)
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions)
  const diagnostics = { noSemanticValidation: false, noSyntaxValidation: false, noSuggestionDiagnostics: true }
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics)
}
