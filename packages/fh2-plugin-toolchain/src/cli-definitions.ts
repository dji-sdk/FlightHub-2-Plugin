// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { CLI_COMMANDS } from './cli-commands.js'
import { PROJECT_PATHS } from './project-policy.js'

export type CliOptionValueType = 'string' | 'number' | 'boolean' | 'enum'
export type CliDefaultRule =
  | { readonly kind: 'literal'; readonly value: string | number | boolean }
  | { readonly kind: 'mode'; readonly values: Readonly<Record<string, string | number | boolean>> }
  | { readonly kind: 'environment'; readonly name: string; readonly fallback?: string; readonly fallbackPath?: string }
  | { readonly kind: 'path'; readonly base: 'projectRoot' | 'home' | 'cwd'; readonly path: string }
  | { readonly kind: 'implementation'; readonly source: string; readonly description: string }

export interface CliOptionDefinition {
  readonly name: string;
  readonly alias?: string;
  /** Preserve commands that normalized an alias token before consuming option values. */
  readonly normalizeAlias?: boolean;
  readonly valueType: CliOptionValueType;
  readonly values?: readonly string[];
  readonly valueAliases?: Readonly<Record<string, string>>;
  readonly repeatable?: boolean;
  readonly duplicateBehavior?: 'last-wins';
  readonly allowInlineFlagValues?: boolean;
  readonly defaultRule?: CliDefaultRule;
  /** Bounds apply to explicit input, not to an omitted-option default (serve uses 0). */
  readonly numericRange?: { readonly min: number; readonly max: number; readonly integer: boolean; readonly excluded?: readonly number[] };
  readonly negates?: string;
  readonly conflicts?: readonly string[];
  readonly description: string;
  readonly invalidValueMessage?: (value: string) => string;
  readonly duplicateMessage?: string;
  readonly conflictMessage?: string;
}

export interface CliArgumentDefinition {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly values?: readonly string[];
  readonly repeatable?: boolean;
  readonly leadingOnly?: boolean;
}

export interface CliBehaviorMetadata {
  /** Reviewed explanations of execution, not declarative parser/dispatch rules. */
  readonly behaviorKind: 'manual-description';
  readonly contexts: readonly string[];
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[];
  readonly successSignals?: readonly string[];
  readonly notes?: readonly string[];
  readonly source: string;
}

export interface CliDefinition {
  readonly name: string;
  readonly summary: string;
  readonly arguments: readonly CliArgumentDefinition[];
  readonly options: readonly CliOptionDefinition[];
  readonly syntax: {
    readonly inlineValues: boolean;
    readonly separator: 'ignore' | 'end-options' | 'reject' | 'positional';
    readonly unknownShortOptions: 'reject' | 'positional';
    readonly help: 'validated' | 'immediate' | 'anywhere';
    readonly validateValuesOnHelp: boolean;
    readonly allowEmptyValues: boolean;
    readonly allowInlineFlagValues: boolean;
  };
}

const HELP: CliOptionDefinition = { name: '--help', valueType: 'boolean', description: '显示帮助' }
const ROOT: CliOptionDefinition = { name: '--root', valueType: 'string', defaultRule: { kind: 'literal', value: '.' }, description: '工程根目录（相对当前工作目录）' }
const MANIFEST: CliOptionDefinition = { name: '--manifest', valueType: 'string', defaultRule: { kind: 'literal', value: `./${PROJECT_PATHS.sourceManifest}` }, description: 'Source Manifest' }
const CONFIG: CliOptionDefinition = { name: '--config', valueType: 'string', description: '指定 Rsbuild config' }
const WATCH: CliOptionDefinition = { name: '--watch', alias: '-w', normalizeAlias: true, valueType: 'boolean', defaultRule: { kind: 'literal', value: true }, conflicts: ['--no-watch'], description: '构建并持续监听' }
const NO_WATCH: CliOptionDefinition = { name: '--no-watch', valueType: 'boolean', negates: '--watch', description: '只构建一次' }
const FRONTEND: CliOptionDefinition = { name: '--frontend', valueType: 'string', repeatable: true, allowInlineFlagValues: false, description: 'Capability 内只选择指定前端插件，可重复传入' }
const BACKEND: CliOptionDefinition = { name: '--backend', valueType: 'string', repeatable: true, allowInlineFlagValues: false, description: 'Capability 内只选择指定后端插件，可重复传入' }
const PORT_RANGE = { min: 1, max: 65_535, integer: true } as const
const PORT: CliOptionDefinition = { name: '--port', valueType: 'number', numericRange: PORT_RANGE, description: '本地服务端口', invalidValueMessage: value => `--port 必须是 1..65535 的整数：${value}` }
const NO_OPEN: CliOptionDefinition = { name: '--no-open', valueType: 'boolean', description: '不自动打开浏览器' }
const CHECK: CliOptionDefinition = { name: '--check', valueType: 'boolean', description: '只检查类型是否最新，不写文件' }
const STANDARD_SYNTAX: CliDefinition['syntax'] = { inlineValues: true, separator: 'ignore', unknownShortOptions: 'reject', help: 'validated', validateValuesOnHelp: false, allowEmptyValues: false, allowInlineFlagValues: true }

type Parameters = Pick<CliDefinition, 'arguments' | 'options' | 'syntax'>
const PARAMETERS: Readonly<Record<string, Parameters>> = {
  create: {
    arguments: [{ name: '项目目录', required: false, description: '新工程目录；交互模式会询问' }],
    options: [
      { name: '--template', valueType: 'enum', values: ['capability-fullstack', 'frontend-basic', 'backend-basic'], valueAliases: { 0: 'capability-fullstack', 1: 'frontend-basic', 2: 'backend-basic' }, defaultRule: { kind: 'mode', values: { capability: 'capability-fullstack', plugin: 'frontend-basic', noninteractive: 'capability-fullstack' } }, description: '工程模板；交互模式未指定 ID 时询问', invalidValueMessage: value => `未知插件模板：${value}。支持：capability-fullstack、frontend-basic、backend-basic。` },
      { name: '--capability-id', valueType: 'string', description: 'Capability ID（生成同名 capability 子目录）' },
      { name: '--frontend-plugin-id', valueType: 'string', description: 'Capability 前端 Plugin ID' },
      { name: '--backend-plugin-id', valueType: 'string', description: 'Capability 后端 Plugin ID' },
      { name: '--issues-plugin-id', valueType: 'string', description: '现场问题示例前端 Plugin ID' },
      { name: '--plugin-id', valueType: 'string', description: '单插件 ID；Capability 模板中等同 frontend-plugin-id' },
      { name: '--name', valueType: 'string', description: '插件展示名称' },
      { name: '--package-manager', valueType: 'enum', values: ['pnpm', 'npm', 'yarn'], defaultRule: { kind: 'mode', values: { pnpm: 'pnpm', npm: 'npm', yarn: 'yarn', fallback: 'pnpm' } }, description: '包管理器；模式由 npm_config_user_agent 检测，未检测到时 fallback；交互模式可选择', invalidValueMessage: value => `未知包管理器：${value}。支持：pnpm、npm、yarn（Classic 1.22.x）。` },
      { name: '--platform-root', valueType: 'string', defaultRule: { kind: 'implementation', source: 'src/create/run.ts#findPlatformRepositoryRoot', description: '环境变量 FH2_PLATFORM_ROOT 或自动发现平台仓' }, description: '使用指定平台仓的本地 SDK/Toolchain' },
      { name: '--install', valueType: 'boolean', conflicts: ['--no-install'], defaultRule: { kind: 'mode', values: { noninteractive: false, repository: false, external: true } }, description: '创建后立即安装依赖；交互模式可选择', duplicateMessage: '不能同时或重复指定 --install/--no-install。', conflictMessage: '不能同时或重复指定 --install/--no-install。' },
      { name: '--no-install', valueType: 'boolean', negates: '--install', description: '跳过依赖安装', duplicateMessage: '不能同时或重复指定 --install/--no-install。' },
      { ...HELP, alias: '-h', repeatable: true },
      { name: '--version', alias: '-v', valueType: 'boolean', repeatable: true, description: '显示版本' },
    ],
    syntax: { ...STANDARD_SYNTAX, separator: 'end-options', validateValuesOnHelp: true, allowInlineFlagValues: false },
  },
  validate: { arguments: [], options: [MANIFEST, CONFIG, ROOT, { name: '--format', valueType: 'enum', values: ['text', 'json'], defaultRule: { kind: 'literal', value: 'text' }, description: '输出格式', invalidValueMessage: value => `--format 只支持 text 或 json：${value}` }, HELP], syntax: STANDARD_SYNTAX },
  generate: { arguments: [], options: [MANIFEST, { name: '--out', valueType: 'string', defaultRule: { kind: 'literal', value: `./${PROJECT_PATHS.generatedTypes}` }, description: '类型输出目录（基于 Manifest 根）' }, ROOT, CHECK, HELP], syntax: STANDARD_SYNTAX },
  types: { arguments: [], options: [{ ...ROOT, defaultRule: { kind: 'path', base: 'cwd', path: '.' }, description: '后端插件根目录；显式路径保持原有直接使用行为' }, CHECK, HELP], syntax: STANDARD_SYNTAX },
  build: { arguments: [], options: [{ name: '--watch', alias: '-w', normalizeAlias: true, valueType: 'boolean', defaultRule: { kind: 'literal', value: false }, description: '持续监听 Manifest、src 与 public 并串行重建' }, CONFIG, { ...ROOT, description: '指定行业 Capability 工作区、Capability 或插件根目录（相对当前工作目录）' }, { ...FRONTEND, description: 'Capability 根：只构建指定前端插件并跳过后端，可重复传入' }, { ...BACKEND, description: 'Capability 根：只构建指定后端插件并跳过前端，可重复传入' }, HELP], syntax: STANDARD_SYNTAX },
  pack: { arguments: [], options: [{ name: '--out-dir', valueType: 'string', defaultRule: { kind: 'mode', values: { 'industry-capability-workspace': `./${PROJECT_PATHS.release}`, 'capability-project': `./${PROJECT_PATHS.release}`, 'frontend-plugin': `./${PROJECT_PATHS.release}`, 'backend-plugin': `./${PROJECT_PATHS.release}`, 'legacy-industry-plugins-root': `./${PROJECT_PATHS.dist}` } }, description: '输出目录' }, { name: '--no-build', valueType: 'boolean', description: 'Capability 根复用最新独立默认配置 Build Report；行业工作区始终重新构建' }, { ...ROOT, description: '指定行业 Capability 工作区、Capability 或插件根目录（相对当前工作目录）' }, HELP], syntax: STANDARD_SYNTAX },
  sign: { arguments: [], options: [{ name: '--in', valueType: 'string', description: 'pack 产物目录（必填）' }, { name: '--out', valueType: 'string', description: '输出 zip 路径（必填）' }, { name: '--keyid', valueType: 'string', defaultRule: { kind: 'environment', name: 'FH2_PLUGIN_SIGN_KEY_ID', fallback: '' }, description: '签名密钥标识' }, HELP], syntax: STANDARD_SYNTAX },
  dev: {
    arguments: [{ name: 'cockpit', required: false, values: ['cockpit'], leadingOnly: true, description: '固定驾驶舱路由，仍挂载 project+message+cockpit，不是单 Host' }],
    options: [MANIFEST, CONFIG, { ...PORT, defaultRule: { kind: 'mode', values: { all: 5175, cockpit: 5176 } }, description: 'Workbench/后端 Gateway 端口' }, WATCH, NO_WATCH, { name: '--frontend-only', valueType: 'boolean', conflicts: ['--backend-only'], description: '全栈工程仅构建并运行前端' }, { name: '--backend-only', valueType: 'boolean', description: 'Capability 仅构建并运行本地后端' }, FRONTEND, BACKEND, ROOT, { name: '--gateway-target', valueType: 'string', description: '代理固定的真实 HTTP Gateway origin' }, { name: '--plugins-dir', valueType: 'string', defaultRule: { kind: 'path', base: 'projectRoot', path: PROJECT_PATHS.dist }, description: '插件静态目录，逗号分隔多个' }, HELP],
    syntax: { ...STANDARD_SYNTAX, validateValuesOnHelp: true },
  },
  preview: {
    arguments: [],
    options: [ROOT, MANIFEST, CONFIG, { name: '--plugin', valueType: 'string', repeatable: true, conflicts: ['--manifest', '--config'], conflictMessage: '--plugin 不能与 --manifest 或 --config 同时使用', description: '增加插件项目目录，可重复传入' }, FRONTEND, { name: '--fh2-url', valueType: 'string', description: '真实司空完整 HTTP URL；未传时交互输入，不支持 HTTPS' }, { ...PORT, defaultRule: { kind: 'literal', value: 4317 }, numericRange: { ...PORT_RANGE, excluded: [443] } }, WATCH, NO_WATCH, NO_OPEN, HELP],
    syntax: { ...STANDARD_SYNTAX, validateValuesOnHelp: true },
  },
  knowledge: {
    arguments: [{ name: '子命令', required: true, values: ['import', 'use', 'status'], description: 'import / use / status；省略返回参数错误' }, { name: '知识包或 ID', required: false, repeatable: true, description: 'import/use 读取第一项；额外位置参数保持旧行为（忽略）' }],
    options: [{ ...ROOT, duplicateBehavior: 'last-wins', description: 'use/status 在这里读写知识锁文件' }, { name: '--force', valueType: 'boolean', repeatable: true, description: 'import 时允许替换同 ID 但内容不同的版本' }, { name: '--json', valueType: 'boolean', repeatable: true, description: 'status 输出机器可读 JSON' }, { ...HELP, alias: '-h', repeatable: true }],
    syntax: { ...STANDARD_SYNTAX, inlineValues: false, separator: 'reject', unknownShortOptions: 'positional', help: 'anywhere', allowEmptyValues: true },
  },
  serve: { arguments: [], options: [{ ...PORT, defaultRule: { kind: 'literal', value: 0 }, description: 'Web IDE HTTP 端口；省略随机分配，显式 0 不接受' }, ROOT, NO_OPEN, HELP], syntax: { ...STANDARD_SYNTAX, validateValuesOnHelp: true } },
  mcp: { arguments: [], options: [{ name: '--root', valueType: 'string', description: '把工具访问边界收纳到指定目录；省略为开放模式，相对路径基于启动 cwd' }, { ...HELP, alias: '-h', description: '显示帮助与 AI 客户端配置指南' }], syntax: { ...STANDARD_SYNTAX, separator: 'reject', help: 'immediate' } },
}

export const CLI_DEFINITIONS: readonly CliDefinition[] = CLI_COMMANDS.map((command) => {
  const parameters = PARAMETERS[command.name]
  if (!parameters) throw new Error(`CLI 缺少生产参数定义：${command.name}`)
  return { ...command, ...parameters }
})

export function renderRootCliUsage (commands: readonly Pick<CliDefinition, 'name' | 'summary'>[] = CLI_DEFINITIONS): string {
  return `FH2 插件工具链\n\n${commands.map(c => `  fh2-plugin ${c.name.padEnd(10)} ${c.summary}`).join('\n')}\n`
}

export function cliDefinition (name: string): CliDefinition {
  const definition = CLI_DEFINITIONS.find(command => command.name === name)
  if (!definition) throw new Error(`CLI 缺少生产参数定义：${name}`)
  return definition
}

export function cliDefault (definition: CliDefinition, name: string, context: { readonly mode?: string; readonly cwd?: string; readonly projectRoot?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {}): string | number | boolean | undefined {
  const rule = definition.options.find(option => option.name === `--${name}`)?.defaultRule
  if (!rule) return undefined
  switch (rule.kind) {
    case 'literal': return rule.value
    case 'mode': return rule.values[context.mode ?? '']
    case 'environment': return context.env?.[rule.name] ?? (rule.fallbackPath ? resolve(homedir(), rule.fallbackPath) : rule.fallback)
    case 'path': return resolve(rule.base === 'home' ? homedir() : rule.base === 'cwd' ? context.cwd! : context.projectRoot!, rule.path)
    case 'implementation': return undefined
  }
}

export function renderCliOptions (definition: CliDefinition): string {
  return `选项：\n${definition.options.map((option) => {
    const names = option.alias ? `${option.name}, ${option.alias}` : option.name
    const value = option.valueType === 'boolean' ? '' : ` <${option.values?.join('|') ?? (option.numericRange ? `${option.numericRange.min}..${option.numericRange.max}` : 'value')}>`
    const rule = option.defaultRule
    const defaults = rule?.kind === 'literal' ? `（默认 ${String(rule.value)}）` : rule?.kind === 'mode' ? `（默认 ${Object.entries(rule.values).map(([mode, value]) => `${mode}=${String(value)}`).join('、')}）` : rule?.kind === 'environment' ? `（默认取 ${rule.name}）` : rule?.kind === 'implementation' ? `（${rule.description}）` : rule?.kind === 'path' ? `（默认 <${rule.base}>/${rule.path}）` : ''
    const aliases = option.valueAliases ? `；快捷值 ${Object.entries(option.valueAliases).map(([alias, value]) => `${alias}=${value}`).join('、')}` : ''
    const excluded = option.numericRange?.excluded ? `；不接受 ${option.numericRange.excluded.join('、')}` : ''
    return `  ${(names + value).padEnd(28)} ${option.description}${defaults}${aliases}${excluded}`
  }).join('\n')}\n`
}

export function renderCliArguments (definition: CliDefinition): string {
  if (definition.arguments.length === 0) return ''
  return `参数：\n${definition.arguments.map(argument => `  ${argument.name.padEnd(24)} ${argument.description}`).join('\n')}\n\n`
}
