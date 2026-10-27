// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestSchema } from 'fh2-plugin-sdk'
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'
import semver from 'semver'
import { cliDefault, cliDefinition, renderCliArguments, renderCliOptions } from '../cli-definitions.js'
import type { CliBehaviorMetadata } from '../cli-definitions.js'
import { parseCliOptionValue, parseCommandArguments } from '../commands/arguments.js'
import { validateBackendSourcePlugin } from '../backend/source-contract.js'
import { DEPENDENCY_BUILD_POLICY } from '../dependency-build-policy.js'
import packageManagerPolicy from '../package-manager-policy.json'
import {
  CapabilityCreateError,
  createCapabilityWorkspace,
  regenerateBackendTypes,
} from '../capability/create.js'

export type PackageManager = 'pnpm' | 'npm' | 'yarn'
export type PluginTemplate = 'capability-fullstack' | 'frontend-basic' | 'backend-basic'

/** Source Manifest 形态：合并双示例的前端基础模板，或 Capability 拆分的单示例插件。 */
type SourceManifestKind = 'frontend-basic' | 'hello-only' | 'issues-only'

interface ParsedArgs {
  readonly directory?: string;
  readonly platformRoot?: string;
  readonly pluginId?: string;
  readonly capabilityId?: string;
  readonly frontendPluginId?: string;
  readonly issuesPluginId?: string;
  readonly backendPluginId?: string;
  readonly name?: string;
  readonly packageManager?: PackageManager;
  readonly template?: PluginTemplate;
  readonly install?: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

interface CreateInput {
  readonly directory: string;
  readonly pluginId: string;
  readonly capabilityId?: string;
  readonly frontendPluginId?: string;
  readonly issuesPluginId?: string;
  readonly backendPluginId?: string;
  readonly name: string;
  readonly packageManager: PackageManager;
  readonly template: PluginTemplate;
  readonly install: boolean;
}

interface PlatformVersions {
  readonly sdk: string;
  readonly toolchain: string;
}

type Writer = Pick<NodeJS.WriteStream, 'write'>
type Ask = (message: string, defaultValue?: string) => Promise<string>
type RunCommand = (command: string, args: readonly string[], cwd: string) => Promise<void>
type DetectPackageManagerVersion = (packageManager: PackageManager) => string | undefined

interface Questioner {
  question(query: string, options: { readonly signal: AbortSignal }): Promise<string>;
}

interface SignalSource {
  once(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface RunCreatePluginOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdinIsTTY?: boolean;
  readonly stdout?: Writer;
  readonly stderr?: Writer;
  readonly ask?: Ask;
  readonly runCommand?: RunCommand;
  readonly detectPackageManagerVersion?: DetectPackageManagerVersion;
  readonly packageRoot?: string;
  readonly generateTypes?: typeof generatePluginTypes;
  /** CLI 入口开启：源码基线版本在仓外不得生成无法从 registry 安装的依赖。 */
  readonly enforceDependencySource?: boolean;
}

class CreatePluginError extends Error {
  constructor (message: string, readonly projectPreserved = false) {
    super(message)
    this.name = 'CreatePluginError'
  }
}

const THIRD_PARTY_VERSIONS = {
  vue: '3.5.41',
  rsbuild: '1.7.6',
  rsbuildVue: '1.2.9',
  typescript: '5.5.4',
  vueTsc: '3.3.9',
  vitest: '2.1.9',
  happyDom: '15.11.7',
  eslint: '9.39.5',
  antfuEslint: '2.27.3',
  nodeTypes: '20.19.43',
} as const

const DEFAULT_PACKAGE_ROOT = resolvePackageRoot(fileURLToPath(import.meta.url))
const pluginIdPattern = new RegExp(manifestSchema.properties.id.pattern)
const DEFINITION = cliDefinition('create')

/** 结构化创建入口。CLI 负责问答和呈现；IDE/MCP 直接传入参数，错误原样抛出。 */
export async function createPluginProject (
  parsed: Omit<ParsedArgs, 'help' | 'version'>,
  options: RunCreatePluginOptions = {},
): Promise<{ readonly input: CreateInput; readonly targetDir: string }> {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT
  const packageVersion = await readPackageVersion(packageRoot)
  const stderr = options.stderr ?? process.stderr
  const ask = options.ask ?? (async () => {
    throw new CreatePluginError('缺少创建参数。')
  })
  const sdkVersion = await readInstalledPackageVersion(packageRoot, 'fh2-plugin-sdk')
  const platformRepositoryRoot = await findPlatformRepositoryRoot(
    cwd,
    parsed.platformRoot ?? env.FH2_PLATFORM_ROOT,
    env.FH2_TOOLCHAIN_PACKAGE_ROOT,
  )

  // FH2_CREATE_ALLOW_UNPUBLISHED_BASELINE=1：仓外 tarball E2E 等受控场景显式放行
  // 未发布源码基线；生成的依赖版本仍写入工程，由调用方自行安装覆盖。
  const enforceDependencySource = options.enforceDependencySource === true
    && env.FH2_CREATE_ALLOW_UNPUBLISHED_BASELINE !== '1'

  if (enforceDependencySource
    && platformRepositoryRoot === undefined
    && isUnpublishedSourceBaseline(packageRoot)) {
    throw new CreatePluginError(
      `当前 create 来自未携带发布标记的 Toolchain（SDK ${sdkVersion}，Toolchain ${packageVersion}），且未定位到 SOURCE 根，不能生成可能需要远端 FH2 包的依赖。`
      + '请使用已初始化源码的 Toolchain bin，或传入 --platform-root <源码根>。',
    )
  }

  const input = await resolveInput(parsed, {
    ask,
    stderr,
    isTTY: options.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    // 依赖可以来自仓外的 SOURCE，但创建目录与安装默认值只看当前工作目录。
    platformRepositoryRoot: await findPlatformRepositoryRootFrom(cwd) !== undefined,
    ...(env.npm_config_user_agent ? { userAgent: env.npm_config_user_agent } : {}),
  })
  validateInput(input)

  const targetDir = resolve(cwd, input.directory)
  await assertTargetAvailable(targetDir)
  const detectedPackageManagerVersion = (options.detectPackageManagerVersion ?? detectPackageManagerVersion)(input.packageManager)
  const packageManagerVersion = supportedPackageManagerVersion(input.packageManager, detectedPackageManagerVersion)
  await createProject({
    input,
    targetDir,
    packageRoot,
    ...(packageManagerVersion === undefined ? {} : { packageManagerVersion }),
    platformVersions: {
      sdk: sdkVersion,
      toolchain: packageVersion,
    },
    ...(platformRepositoryRoot === undefined ? {} : { platformRepositoryRoot }),
    generateTypes: options.generateTypes ?? generatePluginTypes,
  })

  writeDependencySourceNotice(stderr, {
    ...(platformRepositoryRoot === undefined ? {} : { platformRepositoryRoot }),
    sdkVersion,
    toolchainVersion: packageVersion,
  })

  return { input, targetDir }
}

export async function runCreatePlugin (options: RunCreatePluginOptions = {}): Promise<number> {
  const args = options.args ?? process.argv.slice(2)
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const packageRoot = options.packageRoot ?? DEFAULT_PACKAGE_ROOT

  let readline: ReturnType<typeof createInterface> | undefined
  const ask = options.ask ?? (async (message: string, defaultValue?: string): Promise<string> => {
    readline ??= createInterface({ input: process.stdin, output: process.stdout })
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    const answer = await askQuestion(readline, process, `${message}${suffix}：`)
    return answer.trim() || defaultValue || ''
  })

  try {
    const parsed = parseCreateArgs(args)
    const packageVersion = await readPackageVersion(packageRoot)
    if (parsed.help) {
      stdout.write(usage())
      return 0
    }
    if (parsed.version) {
      stdout.write(`${packageVersion}\n`)
      return 0
    }
    const { input, targetDir } = await createPluginProject(parsed, { ...options, ask })

    if (input.template === 'capability-fullstack') {
      stdout.write(`✓ Capability 工程已创建：${targetDir}\n`)
      stdout.write(`✓ 工作区清单已生成：packages.json\n`)
      stdout.write(`✓ capabilities.json 校验通过：${input.capabilityId}/capabilities.json\n`)
      stdout.write(`✓ 前端插件已生成：${input.capabilityId}/frontend/${input.frontendPluginId}\n`)
      stdout.write(`✓ 前端插件已生成：${input.capabilityId}/frontend/${input.issuesPluginId}\n`)
      stdout.write(`✓ 后端插件 Worker 契约校验通过：${input.capabilityId}/backend/${input.backendPluginId}\n`)
      stdout.write(`✓ 类型已生成：${input.capabilityId}/frontend/${input.frontendPluginId}/src/generated/plugin-types.ts\n`)
      stdout.write(`✓ 类型已生成：${input.capabilityId}/frontend/${input.issuesPluginId}/src/generated/plugin-types.ts\n`)
      stdout.write(`✓ 后端类型已生成：${input.capabilityId}/backend/${input.backendPluginId}/types/\n`)
    } else if (input.template === 'backend-basic') {
      stdout.write(`✓ 后端插件工程已创建：${targetDir}\n`)
      stdout.write('✓ 后端插件 Worker 契约校验通过\n')
      stdout.write('✓ 后端类型已生成：types/\n')
    } else {
      stdout.write(`✓ 插件工程已创建：${targetDir}\n`)
      stdout.write('✓ Source Manifest 校验通过\n')
      stdout.write('✓ 类型已生成：src/generated/plugin-types.ts\n')
    }

    if (input.install) {
      const runCommand = options.runCommand ?? runPackageManagerCommand
      try {
        await runCommand(input.packageManager, ['install'], targetDir)
      } catch (error) {
        throw new CreatePluginError(
          `依赖安装失败：${errorMessage(error)}\n工程已保留，可进入目录后重新执行 ${input.packageManager} install。`,
          true,
        )
      }
      try {
        await runCommand(input.packageManager, ['run', 'generate'], targetDir)
      } catch (error) {
        throw new CreatePluginError(
          `安装后类型复验失败：${errorMessage(error)}\n工程已保留，可进入目录后重新执行 ${input.packageManager} run generate。`,
          true,
        )
      }
      stdout.write('✓ 依赖已安装\n')
      stdout.write('✓ 安装后类型复验通过\n')
    }

    const changeDirectory = process.platform === 'win32'
      ? `cd /d ${quoteShellArg(input.directory, 'win32')}`
      : `cd ${quoteShellArg(input.directory, process.platform)}`
    stdout.write(`\n下一步：\n  ${changeDirectory}\n`)
    if (!input.install) stdout.write(`  ${input.packageManager} install\n`)
    if (input.template === 'capability-fullstack') {
      stdout.write(`  ${input.packageManager} run generate\n`)
      stdout.write(`  ${input.packageManager} run validate\n`)
      stdout.write(`  ${input.packageManager} run dev\n`)
      stdout.write(`  ${input.packageManager} run dev:cockpit\n`)
      stdout.write(`  ${input.packageManager} run preview\n`)
      stdout.write(`  ${input.packageManager} run build\n`)
      stdout.write(`  ${input.packageManager} run pack\n`)
      stdout.write(`  ${input.packageManager} run test\n`)
    } else if (input.template === 'backend-basic') {
      stdout.write(`  ${input.packageManager} run validate\n`)
      stdout.write(`  ${input.packageManager} run dev\n`)
      stdout.write(`  ${input.packageManager} run build\n`)
    } else {
      stdout.write(`  ${input.packageManager} run validate\n`)
      stdout.write(`  ${input.packageManager} run test\n`)
      stdout.write(`  ${input.packageManager} run dev\n`)
    }
    return 0
  } catch (error) {
    if (isAbortError(error)) {
      stderr.write('[fh2-plugin create] 已取消。\n')
      return 130
    }
    const suffix = (error instanceof CreatePluginError || error instanceof CapabilityCreateError)
      && error.projectPreserved
      ? '\n[fh2-plugin create] 工程已保留。\n'
      : '\n'
    stderr.write(`[fh2-plugin create] ${errorMessage(error)}${suffix}`)
    return 1
  } finally {
    readline?.close()
  }
}

export function parseCreateArgs (args: readonly string[]): ParsedArgs {
  const parsed = parseCommandArguments(args, DEFINITION)
  const directory = parsed.positional[0]
  const { 'platform-root': platformRoot, 'plugin-id': pluginId, 'capability-id': capabilityId, 'frontend-plugin-id': frontendPluginId, 'issues-plugin-id': issuesPluginId, 'backend-plugin-id': backendPluginId, name } = parsed.values
  const packageManager = parsed.values['package-manager'] as PackageManager | undefined
  const template = parsed.values.template as PluginTemplate | undefined
  const install = parsed.switches.has('install') ? true : parsed.switches.has('no-install') ? false : undefined
  return {
    ...(directory ? { directory } : {}),
    ...(platformRoot ? { platformRoot } : {}),
    ...(pluginId ? { pluginId } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    ...(frontendPluginId ? { frontendPluginId } : {}),
    ...(issuesPluginId ? { issuesPluginId } : {}),
    ...(backendPluginId ? { backendPluginId } : {}),
    ...(name ? { name } : {}),
    ...(packageManager ? { packageManager } : {}),
    ...(template ? { template } : {}),
    ...(install !== undefined ? { install } : {}),
    help: parsed.flag('help'),
    version: parsed.flag('version'),
  }
}

export async function askQuestion (
  readline: Questioner,
  signals: SignalSource,
  prompt: string,
): Promise<string> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signals.once('SIGINT', abort)
  try {
    return await readline.question(prompt, { signal: controller.signal })
  } finally {
    signals.off('SIGINT', abort)
  }
}

export function quoteShellArg (value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll('\'', `'"'"'`)}'`
}

async function resolveInput (
  parsed: Omit<ParsedArgs, 'help' | 'version'>,
  options: {
    readonly ask: Ask;
    readonly stderr: Writer;
    readonly isTTY: boolean;
    readonly platformRepositoryRoot: boolean;
    readonly userAgent?: string;
  },
): Promise<CreateInput> {
  const hasCapabilityArguments = parsed.capabilityId !== undefined
    || parsed.frontendPluginId !== undefined
    || parsed.issuesPluginId !== undefined
    || parsed.backendPluginId !== undefined
  const template = parsed.template ?? (hasCapabilityArguments
    ? cliDefault(DEFINITION, 'template', { mode: 'capability' }) as PluginTemplate
    : parsed.pluginId !== undefined
      ? cliDefault(DEFINITION, 'template', { mode: 'plugin' }) as PluginTemplate
      : options.isTTY
        ? await askPluginTemplate(options.ask, options.stderr)
        : cliDefault(DEFINITION, 'template', { mode: 'noninteractive' }) as PluginTemplate)
  if (template === 'capability-fullstack') return await resolveCapabilityInput(parsed, options)

  if (!options.isTTY && (!parsed.directory || !parsed.pluginId)) {
    throw new CreatePluginError('非交互模式创建单插件（frontend-basic/backend-basic）必须提供项目目录和 --plugin-id。')
  }
  if (hasCapabilityArguments) {
    throw new CreatePluginError('只有 Capability 模板支持 --capability-id、--frontend-plugin-id、--issues-plugin-id 和 --backend-plugin-id。')
  }

  const pluginId = parsed.pluginId ?? await askPluginId(
    options.ask,
    options.stderr,
    parsed.directory === undefined ? undefined : suggestPluginId(parsed.directory),
  )
  const defaultDirectory = options.platformRepositoryRoot ? join('examples', pluginId) : pluginId
  const directory = parsed.directory ?? await options.ask(
    '项目目录（默认使用 Plugin ID，仅决定生成路径）',
    defaultDirectory,
  )
  const defaultName = humanizePluginName(pluginId)
  const name = parsed.name ?? (options.isTTY
    ? await options.ask('插件名称（Workbench 显示名称）', defaultName)
    : defaultName)
  const detectedManager = cliDefault(DEFINITION, 'package-manager', { mode: detectPackageManager(options.userAgent) ?? 'fallback' }) as PackageManager
  const packageManager = parsed.packageManager ?? (options.isTTY
    ? parsePackageManager(await options.ask('包管理器（pnpm/npm/yarn）', detectedManager))
    : detectedManager)
  const install = parsed.install ?? (options.isTTY
    ? parseYes(await options.ask('是否立即安装依赖（是/否）', cliDefault(DEFINITION, 'install', { mode: options.platformRepositoryRoot ? 'repository' : 'external' }) ? '是' : '否'))
    : cliDefault(DEFINITION, 'install', { mode: 'noninteractive' }) as boolean)

  return { directory, pluginId, name, packageManager, template, install }
}

async function resolveCapabilityInput (
  parsed: Omit<ParsedArgs, 'help' | 'version'>,
  options: {
    readonly ask: Ask;
    readonly stderr: Writer;
    readonly isTTY: boolean;
    readonly platformRepositoryRoot: boolean;
    readonly userAgent?: string;
  },
): Promise<CreateInput> {
  if (!options.isTTY && !parsed.directory) {
    throw new CreatePluginError('非交互模式创建 Capability 必须提供项目目录。')
  }
  if (parsed.pluginId !== undefined && parsed.frontendPluginId !== undefined) {
    throw new CreatePluginError('不能同时指定 --plugin-id 与 --frontend-plugin-id。')
  }

  const defaultCapabilityId = parsed.capabilityId ?? 'exp_capability'
  const defaultDirectory = options.platformRepositoryRoot
    ? join('examples', defaultCapabilityId)
    : defaultCapabilityId
  let directory = parsed.directory
  while (directory === undefined) {
    const answer = await options.ask(
      '工作区目录（例如 exp_hello；目录名也作为能力 ID）',
      defaultDirectory,
    )
    if (parsed.capabilityId !== undefined || pluginIdPattern.test(basename(answer.trim()))) {
      directory = answer
    } else {
      options.stderr.write('目录名也作为能力 ID，请使用 exp_ 或 official_ 前缀的小写短名，例如 exp_hello。\n')
    }
  }
  const capabilityId = parsed.capabilityId ?? basename(directory.trim())
  const frontendPluginId = parsed.frontendPluginId ?? parsed.pluginId ?? `${capabilityId}_frontend`
  const issuesPluginId = parsed.issuesPluginId ?? `${capabilityId}_issues`
  const backendPluginId = parsed.backendPluginId ?? `${capabilityId}_backend`
  const defaultName = humanizePluginName(capabilityId)
  const name = parsed.name ?? (options.isTTY
    ? await options.ask('Capability 名称（Workbench 显示名称）', defaultName)
    : defaultName)
  const detectedManager = cliDefault(DEFINITION, 'package-manager', { mode: detectPackageManager(options.userAgent) ?? 'fallback' }) as PackageManager
  const packageManager = parsed.packageManager ?? (options.isTTY
    ? parsePackageManager(await options.ask('包管理器（pnpm/npm/yarn）', detectedManager))
    : detectedManager)
  const install = parsed.install ?? (options.isTTY
    ? parseYes(await options.ask('是否立即安装依赖（是/否）', cliDefault(DEFINITION, 'install', { mode: options.platformRepositoryRoot ? 'repository' : 'external' }) ? '是' : '否'))
    : cliDefault(DEFINITION, 'install', { mode: 'noninteractive' }) as boolean)

  return {
    directory,
    pluginId: frontendPluginId,
    capabilityId,
    frontendPluginId,
    issuesPluginId,
    backendPluginId,
    name,
    packageManager,
    template: 'capability-fullstack',
    install,
  }
}

function validateInput (input: CreateInput): void {
  const directoryName = basename(input.directory.trim())
  if (directoryName === '' || directoryName === '.' || directoryName === '..') {
    throw new CreatePluginError('项目目录必须是新的有效路径，不能使用当前目录或父目录。')
  }
  if (input.name.trim() === '') throw new CreatePluginError('插件名称不能为空。')

  if (input.template === 'capability-fullstack') {
    const capabilityId = input.capabilityId
    const frontendPluginId = input.frontendPluginId
    const issuesPluginId = input.issuesPluginId
    const backendPluginId = input.backendPluginId
    if (capabilityId === undefined || frontendPluginId === undefined || issuesPluginId === undefined || backendPluginId === undefined) {
      throw new CreatePluginError('Capability 模板缺少 Capability、前端或后端 Plugin ID。')
    }
    for (const id of [capabilityId, frontendPluginId, issuesPluginId, backendPluginId]) assertPluginId(id)
    if (new Set([frontendPluginId, issuesPluginId, backendPluginId]).size !== 3) {
      throw new CreatePluginError('同一 Capability 内前端、现场问题与后端 Plugin ID 必须不同。')
    }
    return
  }
  assertPluginId(input.pluginId)
}

function assertPluginId (pluginId: string): void {
  if (!pluginIdPattern.test(pluginId)) {
    throw new CreatePluginError(`Plugin ID 必须使用 official_ 或 exp_ 前缀的小写短名：${pluginId}`)
  }
}

async function assertTargetAvailable (targetDir: string): Promise<void> {
  try {
    const targetStat = await lstat(targetDir)
    if (targetStat.isSymbolicLink()) throw new CreatePluginError(`目标目录不能是符号链接：${targetDir}`)
    if (!targetStat.isDirectory()) throw new CreatePluginError(`目标路径不是目录：${targetDir}`)
    const entries = await import('node:fs/promises').then(fs => fs.readdir(targetDir))
    if (entries.length > 0) throw new CreatePluginError(`目标目录非空，拒绝覆盖：${targetDir}`)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
}

async function createProject (options: {
  readonly input: CreateInput;
  readonly targetDir: string;
  readonly packageRoot: string;
  readonly platformVersions: PlatformVersions;
  readonly packageManagerVersion?: string;
  readonly platformRepositoryRoot?: string;
  readonly generateTypes: typeof generatePluginTypes;
}): Promise<void> {
  const { input, targetDir, packageRoot, platformVersions, packageManagerVersion, platformRepositoryRoot, generateTypes } = options
  const pnpmOverrides = input.packageManager === 'pnpm'
    ? localOverrides(platformRepositoryRoot, targetDir)
    : undefined
  if (input.template === 'capability-fullstack') {
    const capabilityId = input.capabilityId!
    const frontendPluginId = input.frontendPluginId!
    const issuesPluginId = input.issuesPluginId!
    const backendPluginId = input.backendPluginId!
    const helloInput: CreateInput = {
      ...input,
      pluginId: frontendPluginId,
      template: 'frontend-basic',
    }
    const issuesInput: CreateInput = {
      ...input,
      pluginId: issuesPluginId,
      template: 'frontend-basic',
    }
    await createCapabilityWorkspace({
      targetDir,
      packageRoot,
      capabilityId,
      capabilityName: input.name.trim(),
      capabilityDescription: `${input.name.trim()}能力描述`,
      frontendPluginId,
      issuesPluginId,
      backendPluginId,
      frontendPlugins: [
        {
          pluginId: frontendPluginId,
          variant: 'hello',
          manifest: createSourceManifest({ pluginId: frontendPluginId, name: input.name.trim(), manifestKind: 'hello-only' }),
          packageJson: createPackageJson(
            helloInput,
            platformVersions,
            join(targetDir, capabilityId, 'frontend', frontendPluginId),
            packageManagerVersion,
            platformRepositoryRoot,
          ),
          readme: createReadme(helloInput, 'hello-only'),
        },
        {
          pluginId: issuesPluginId,
          variant: 'issues',
          manifest: createSourceManifest({ pluginId: issuesPluginId, name: `${input.name.trim()} 现场问题`, manifestKind: 'issues-only' }),
          packageJson: createPackageJson(
            issuesInput,
            platformVersions,
            join(targetDir, capabilityId, 'frontend', issuesPluginId),
            packageManagerVersion,
            platformRepositoryRoot,
          ),
          readme: createReadme(issuesInput, 'issues-only'),
        },
      ],
      rootPackageJson: createCapabilityPackageJson(input, platformVersions, targetDir, packageManagerVersion, platformRepositoryRoot),
      rootReadme: createCapabilityReadme(input),
      packagesManifest: `${JSON.stringify([{
        packageId: `${capabilityId}_package`,
        name: `${input.name.trim()}包`,
        capabilityIds: [capabilityId],
      }], null, 2)}\n`,
      ...(pnpmOverrides === undefined ? {} : { pnpmOverrides }),
      generateTypes,
    })
    return
  }
  if (input.template === 'backend-basic') {
    const parentDir = dirname(targetDir)
    const targetExisted = await pathExists(targetDir)
    await mkdir(parentDir, { recursive: true })
    const stagingDir = await mkdtemp(join(parentDir, `.${basename(targetDir)}.fh2-create-`))
    let stagingCommitted = false

    try {
      await cp(join(packageRoot, 'template-backend'), stagingDir, { recursive: true })
      // mock/ 与 Capability 模板共用同一来源：单后端插件的 dev 回退到插件自身根找 mock。
      await cp(join(packageRoot, 'template-capability', 'mock'), join(stagingDir, 'mock'), { recursive: true })
      await writeFile(join(stagingDir, '.gitignore'), 'node_modules/\ndist/\n.fh2/\n.DS_Store\n', 'utf8')
      await writeFile(join(stagingDir, '.npmrc'), '', 'utf8')

      // 单插件工程没有 backend/ 层级：dev 命令与语境从 Capability 根改为插件根。
      // 场景改写必须在占位符替换之前，否则 dev 命令里的 __BACKEND_PLUGIN_ID__ 已被展开。
      const readmePath = join(stagingDir, 'README.md')
      const readmeSource = (await readFile(readmePath, 'utf8'))
        .replace('# 在 Capability 根目录：', '# 在插件根目录：')
        .replace('pnpm exec fh2-plugin dev --root backend/__BACKEND_PLUGIN_ID__', `${input.packageManager} run dev`)
        .replace('`mock/events/` 路径相对 Capability 根', '`mock/events/` 路径相对插件根')
        .replace('pnpm exec fh2-plugin types --check', `${input.packageManager} run types:check`)
        .replace('pnpm exec fh2-plugin types', `${input.packageManager} run types`)
        .replace('pnpm exec fh2-plugin validate', `${input.packageManager} run validate`)
        .replace('pnpm exec fh2-plugin build', `${input.packageManager} run build`)
      await writeFile(readmePath, readmeSource, 'utf8')

      for (const file of ['fh2-plugin.json', 'schema.sql', 'README.md']) {
        const path = join(stagingDir, file)
        if (!existsSync(path)) continue
        const source = await readFile(path, 'utf8')
        await writeFile(path, source
          .replaceAll('__BACKEND_PLUGIN_ID__', input.pluginId)
          .replaceAll('__BACKEND_PLUGIN_NAME__', input.name.trim()), 'utf8')
      }

      await writeJson(join(stagingDir, 'package.json'), createBackendPackageJson(input, platformVersions, targetDir, packageManagerVersion, platformRepositoryRoot))
      if (input.packageManager === 'pnpm') {
        await writeFile(join(stagingDir, 'pnpm-workspace.yaml'), formatPnpmWorkspace({ ...(pnpmOverrides === undefined ? {} : { overrides: pnpmOverrides }), ...DEPENDENCY_BUILD_POLICY }), 'utf8')
      }

      const backendValidation = validateBackendSourcePlugin(stagingDir)
      if (!backendValidation.ok) {
        throw new CreatePluginError(
          `后端插件 Worker 契约校验失败：${backendValidation.diagnostics.map(item => `${item.code}: ${item.message}`).join('；')}`,
        )
      }
      await regenerateBackendTypes(stagingDir)

      if (targetExisted) await rmdir(targetDir)
      await rename(stagingDir, targetDir)
      stagingCommitted = true
    } finally {
      if (!stagingCommitted) await rm(stagingDir, { recursive: true, force: true })
    }
    return
  }
  const parentDir = dirname(targetDir)
  const targetExisted = await pathExists(targetDir)
  await mkdir(parentDir, { recursive: true })
  const stagingDir = await mkdtemp(join(parentDir, `.${basename(targetDir)}.fh2-create-`))
  let stagingCommitted = false

  try {
    await cp(join(packageRoot, 'template'), stagingDir, { recursive: true })
    await rename(join(stagingDir, '_gitignore'), join(stagingDir, '.gitignore'))
    await rename(join(stagingDir, '_npmrc'), join(stagingDir, '.npmrc'))
    await rename(join(stagingDir, '_vscode'), join(stagingDir, '.vscode'))

    const manifest = createSourceManifest({ pluginId: input.pluginId, name: input.name.trim(), manifestKind: 'frontend-basic' })
    await writeJson(join(stagingDir, 'fh2-plugin.json'), manifest)
    await writeJson(join(stagingDir, 'package.json'), createPackageJson(input, platformVersions, targetDir, packageManagerVersion, platformRepositoryRoot))
    if (input.packageManager === 'pnpm') {
      // pnpm 10 的 overrides 只认 pnpm-workspace.yaml；单包工程无 packages 字段亦可作为纯 settings 文件。
      await writeFile(join(stagingDir, 'pnpm-workspace.yaml'), formatPnpmWorkspace({ ...(pnpmOverrides === undefined ? {} : { overrides: pnpmOverrides }), ...DEPENDENCY_BUILD_POLICY }), 'utf8')
    }
    await writeFile(join(stagingDir, 'README.md'), createReadme(input, 'frontend-basic'), 'utf8')

    try {
      const generated = generateTypes({ manifest, outDir: join(stagingDir, 'src/generated') })
      const generatedFile = join(stagingDir, 'src/generated', generated.fileName)
      await mkdir(dirname(generatedFile), { recursive: true })
      await writeFile(generatedFile, generated.source, 'utf8')
    } catch (error) {
      if (targetExisted) await rmdir(targetDir)
      await rename(stagingDir, targetDir)
      stagingCommitted = true
      throw new CreatePluginError(`首次类型生成失败：${errorMessage(error)}`, true)
    }

    if (targetExisted) await rmdir(targetDir)
    await rename(stagingDir, targetDir)
    stagingCommitted = true
  } finally {
    if (!stagingCommitted) await rm(stagingDir, { recursive: true, force: true })
  }
}

function createSourceManifest (input: {
  readonly pluginId: string;
  readonly name: string;
  readonly manifestKind: SourceManifestKind;
}): PluginManifest {
  if (input.manifestKind === 'hello-only') {
    return {
      id: input.pluginId,
      name: input.name.trim(),
      version: '0.1.0',
      entry: './plugin.js',
      extensions: [
        { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
        { id: 'hello-panel', point: 'cockpit.ui.left-panel' },
      ],
      views: { 'hello-panel': { entry: './views/hello-panel.js' } },
      contributes: {
        icons: [{ id: 'plugin', src: './icons/plugin.svg' }],
      },
    }
  }
  if (input.manifestKind === 'issues-only') {
    return {
      id: input.pluginId,
      name: input.name.trim(),
      version: '0.1.0',
      description: 'Cockpit 现场问题面板与弹窗示例',
      entry: './plugin.js',
      permissions: ['platform:dialog'],
      extensions: [
        { id: 'issue-entry', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' },
        { id: 'issue-panel', point: 'cockpit.ui.left-bottom-panels' },
      ],
      views: {
        'issue-panel': { entry: './views/issue-panel.js' },
        'issue-dialog': { entry: './views/issue-dialog.js' },
      },
      contributes: {
        icons: [
          { id: 'issue', src: './icons/issue.svg' },
          { id: 'issue-active', src: './icons/issue-active.svg' },
        ],
      },
    }
  }
  return {
    id: input.pluginId,
    name: input.name.trim(),
    version: '0.1.0',
    description: 'Cockpit 入门面板与现场问题弹窗示例',
    entry: './plugin.js',
    permissions: ['platform:dialog'],
    extensions: [
      { id: 'hello-action', point: 'cockpit.ui.toolbar-actions' },
      { id: 'hello-panel', point: 'cockpit.ui.left-panel' },
      { id: 'issue-entry', point: 'cockpit.ui.toolbar-actions', anchor: 'footer-toolbar:before-ai' },
      { id: 'issue-panel', point: 'cockpit.ui.left-bottom-panels' },
    ],
    views: {
      'hello-panel': { entry: './views/hello-panel.js' },
      'issue-panel': { entry: './views/issue-panel.js' },
      'issue-dialog': { entry: './views/issue-dialog.js' },
    },
    contributes: {
      icons: [
        { id: 'plugin', src: './icons/plugin.svg' },
        { id: 'issue', src: './icons/issue.svg' },
        { id: 'issue-active', src: './icons/issue-active.svg' },
      ],
    },
  }
}

function createPackageJson (
  input: CreateInput,
  versions: PlatformVersions,
  targetDir: string,
  packageManagerVersion?: string,
  platformRepositoryRoot?: string,
): object {
  const sdkVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-sdk') ?? versions.sdk
  const toolchainVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-toolchain') ?? versions.toolchain
  const localResolutions = localOverrides(platformRepositoryRoot, targetDir)
  return {
    name: input.pluginId,
    version: '0.1.0',
    private: true,
    type: 'module',
    ...(packageManagerField(input, packageManagerVersion)),
    engines: { node: '>=20.19' },
    scripts: {
      generate: 'fh2-plugin generate',
      validate: 'fh2-plugin validate',
      build: 'fh2-plugin build',
      watch: 'fh2-plugin build --watch',
      dev: 'fh2-plugin dev',
      'dev:frontend': 'fh2-plugin dev --frontend-only',
      'dev:cockpit': 'fh2-plugin dev cockpit',
      'dev:cockpit:frontend': 'fh2-plugin dev cockpit --frontend-only',
      preview: 'fh2-plugin preview',
      test: 'vitest run',
      tsc: 'vue-tsc --noEmit -p tsconfig.json',
      lint: 'eslint .',
    },
    dependencies: {
      'fh2-plugin-sdk': sdkVersion,
      vue: THIRD_PARTY_VERSIONS.vue,
    },
    devDependencies: {
      '@antfu/eslint-config': THIRD_PARTY_VERSIONS.antfuEslint,
      'fh2-plugin-toolchain': toolchainVersion,
      '@rsbuild/core': THIRD_PARTY_VERSIONS.rsbuild,
      '@rsbuild/plugin-vue': THIRD_PARTY_VERSIONS.rsbuildVue,
      '@types/node': THIRD_PARTY_VERSIONS.nodeTypes,
      eslint: THIRD_PARTY_VERSIONS.eslint,
      'happy-dom': THIRD_PARTY_VERSIONS.happyDom,
      typescript: THIRD_PARTY_VERSIONS.typescript,
      vitest: THIRD_PARTY_VERSIONS.vitest,
      'vue-tsc': THIRD_PARTY_VERSIONS.vueTsc,
    },
    ...(localResolutions === undefined ? {} : overrideFields(input, localResolutions)),
  }
}

function createBackendPackageJson (
  input: CreateInput,
  versions: PlatformVersions,
  targetDir: string,
  packageManagerVersion?: string,
  platformRepositoryRoot?: string,
): object {
  const sdkVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-sdk') ?? versions.sdk
  const toolchainVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-toolchain') ?? versions.toolchain
  const localResolutions = localOverrides(platformRepositoryRoot, targetDir)
  return {
    name: input.pluginId,
    version: '0.1.0',
    private: true,
    type: 'module',
    ...(packageManagerField(input, packageManagerVersion)),
    engines: { node: '>=20.19' },
    scripts: {
      generate: 'fh2-plugin generate',
      validate: 'fh2-plugin validate',
      build: 'fh2-plugin build',
      watch: 'fh2-plugin build --watch',
      dev: 'fh2-plugin dev',
      types: 'fh2-plugin types',
      'types:check': 'fh2-plugin types --check',
      tsc: 'tsc --noEmit -p tsconfig.json',
    },
    dependencies: {
      'fh2-plugin-sdk': sdkVersion,
    },
    devDependencies: {
      'fh2-plugin-toolchain': toolchainVersion,
      typescript: THIRD_PARTY_VERSIONS.typescript,
    },
    ...(localResolutions === undefined ? {} : overrideFields(input, localResolutions)),
  }
}

function createCapabilityPackageJson (
  input: CreateInput,
  versions: PlatformVersions,
  targetDir: string,
  packageManagerVersion?: string,
  platformRepositoryRoot?: string,
): object {
  const capabilityId = input.capabilityId!
  const sdkVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-sdk') ?? versions.sdk
  const toolchainVersion = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-toolchain') ?? versions.toolchain
  const localResolutions = localOverrides(platformRepositoryRoot, targetDir)
  return {
    name: capabilityId,
    version: '0.1.0',
    private: true,
    type: 'module',
    ...(packageManagerField(input, packageManagerVersion)),
    engines: { node: '>=20.19' },
    workspaces: [`${capabilityId}/frontend/*`],
    scripts: {
      // 命令在 workspace 根执行，经 --root 指向 capability 子目录（与 build/pack/dev 的 Capability 根发现一致）。
      generate: `fh2-plugin generate --root ${capabilityId}`,
      validate: `fh2-plugin validate --root ${capabilityId}`,
      build: `fh2-plugin build --root ${capabilityId}`,
      dev: `fh2-plugin dev --root ${capabilityId}`,
      'dev:cockpit': `fh2-plugin dev cockpit --root ${capabilityId}`,
      'dev:frontend': `fh2-plugin dev --root ${capabilityId} --frontend-only`,
      'dev:backend': `fh2-plugin dev --root ${capabilityId} --backend-only`,
      preview: `fh2-plugin preview --root ${capabilityId}`,
      pack: `fh2-plugin pack --root ${capabilityId}`,
      test: workspaceTestCommand(input.packageManager),
    },
    devDependencies: {
      // 根级显式声明 SDK 与 Toolchain，确保 pnpm 满足 Toolchain 对 SDK 的传递精确依赖。
      'fh2-plugin-sdk': sdkVersion,
      'fh2-plugin-toolchain': toolchainVersion,
    },
    ...(localResolutions === undefined ? {} : overrideFields(input, localResolutions)),
  }
}

/**
 * 平台仓库内创建时返回本地包 file: 覆盖映射，用于拦截本地包传递依赖的 registry 解析。
 * pnpm 由 pnpm-workspace.yaml overrides 消费（见 createProject），npm/yarn 由 package.json 消费。
 */
function localOverrides (
  platformRepositoryRoot: string | undefined,
  targetDir: string,
): Record<string, string> | undefined {
  if (platformRepositoryRoot === undefined) return undefined
  const sdk = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-sdk')
  const toolchain = localPackageSpec(platformRepositoryRoot, targetDir, 'fh2-plugin-toolchain')
  if (sdk === undefined || toolchain === undefined || !sdk.startsWith('file:')) return undefined
  return {
    'fh2-plugin-sdk': sdk,
    'fh2-plugin-toolchain': toolchain,
  }
}

function overrideFields (
  input: CreateInput,
  overrides: Record<string, string>,
): Record<string, Record<string, string>> {
  // pnpm 10 只读取 pnpm-workspace.yaml（createProject 已生成），子 workspace 的
  // package.json 放 resolutions 只会产生 warning；npm/yarn 分别使用自己的字段。
  if (input.packageManager === 'npm') return { overrides }
  if (input.packageManager === 'yarn') return { resolutions: overrides }
  return {}
}

function packageManagerField (
  input: CreateInput,
  packageManagerVersion: string | undefined,
): Record<string, string> {
  if (packageManagerVersion === undefined) return {}
  return { packageManager: `${input.packageManager}@${packageManagerVersion}` }
}

function formatPnpmWorkspace (options: {
  readonly packages?: readonly string[];
  readonly overrides?: Record<string, string>;
  readonly onlyBuiltDependencies?: readonly string[];
  readonly ignoredBuiltDependencies?: readonly string[];
}): string {
  const lines: string[] = []
  if (options.packages !== undefined) {
    lines.push('packages:')
    for (const entry of options.packages) lines.push(`  - ${entry}`)
  }
  if (options.overrides !== undefined) {
    lines.push('overrides:')
    // plain 标量键：生成工程自身的 yaml/plain-scalar lint 拒绝不必要的引号
    for (const [name, spec] of Object.entries(options.overrides)) lines.push(`  ${name}: ${spec}`)
  }
  if (options.onlyBuiltDependencies !== undefined) {
    lines.push('onlyBuiltDependencies:')
    for (const name of options.onlyBuiltDependencies) lines.push(`  - ${name}`)
  }
  if (options.ignoredBuiltDependencies !== undefined) {
    lines.push('ignoredBuiltDependencies:')
    for (const name of options.ignoredBuiltDependencies) lines.push(`  - ${name}`)
  }
  return `${lines.join('\n')}\n`
}

function detectPackageManagerVersion (packageManager: PackageManager): string | undefined {
  try {
    // win32 下包管理器是 .cmd shim，须经 cmd.exe 解析（同 packageManagerSpawnPlan）
    const result = spawnSync(packageManager, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' })
    const version = result.stdout?.trim()
    return version === '' || version === undefined ? undefined : version
  } catch {
    return undefined
  }
}

function supportedPackageManagerVersion (
  packageManager: PackageManager,
  detectedVersion: string | undefined,
): string | undefined {
  // 生成工程使用与 SOURCE 相同的 pnpm 支持范围，不限制调用 create 的版本。
  if (packageManager === 'pnpm') {
    return detectedVersion !== undefined && semver.satisfies(detectedVersion, packageManagerPolicy.pnpm.range)
      ? detectedVersion
      : packageManagerPolicy.pnpm.defaultVersion
  }
  return detectedVersion
}

function workspaceTestCommand (packageManager: PackageManager): string {
  if (packageManager === 'npm') return 'npm run test --workspaces --if-present'
  if (packageManager === 'yarn') return 'yarn workspaces run test'
  return 'pnpm -r --if-present test'
}

function createReadme (input: CreateInput, manifestKind: SourceManifestKind): string {
  const run = `${input.packageManager} run`
  return [
    `# ${input.name.trim()}`,
    '',
    `FH2 插件工程，Plugin ID：\`${input.pluginId}\`。`,
    '',
    '## 插件化开发者工具依赖',
    '',
    '源码取自 https://github.com/dji-sdk/FlightHub-2-Plugin（clone 或解压 ZIP），先在源码根运行 `pnpm install --frozen-lockfile`，再运行 `pnpm link:toolchain`。Node 最低版本为 20.19。',
    '创建时使用该源码的 `packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs`，并用 `--platform-root <源码根>` 明确依赖来源；不要求发布或安装 FH2 npm 包。',
    '工程依赖和覆盖只引用本地 `file:` SDK/Toolchain。Toolchain 自带 `developer-runtime/` 运行投影，不另装完整 Contract；第三方依赖沿用你已有的 registry 配置，模板 `.npmrc` 不写私有 scope。',
    '保留固定源码目录。移动目录或升级版本后，在新的源码根重新构建，核对本工程的 `file:` 路径和覆盖，再显式重装、生成与校验；不会自动升级其他工程。',
    '',
    '## 开始开发',
    '',
    '```bash',
    `${input.packageManager} install`,
    `${run} dev`,
    '```',
    '',
    '`dev` 会先完成一次构建，再启动 Workbench 并持续监听源码，不需要预先执行 `build`。',
    '启动前确认构建写入、端口和常驻进程影响；使用终端本次打印的完整地址，用完 Ctrl+C 停止并确认 watcher 与端口清理。',
    '模板贡献位于 Cockpit，默认团队页看不到这些按钮和面板。在在线设备卡点击“进入虚拟驾驶舱”图标，或先打开设备小窗，再点击小窗的“虚拟驾驶舱”按钮，在新页签查看示例。',
    `也可先停止已有 dev，在本前端插件目录运行 \`${run} dev:cockpit\`，直接进入 Cockpit；仍使用本次终端打印的完整地址。`,
    '',
    '提交前在本工程根运行有限质量命令：',
    '',
    '```bash',
    `${run} generate`,
    `${run} validate`,
    `${run} test`,
    `${run} tsc`,
    `${run} lint`,
    `${run} build`,
    '```',
    '',
    '浏览器打开终端输出的 Workbench 地址，可在 Demo Host 中查看插件按钮和 View。',
    `需要在真实司空私有化环境验证前端时，运行 \`${run} preview\`；命令会询问司空地址并自动打开插件调试入口。`,
    ...(manifestKind === 'frontend-basic' || manifestKind === 'issues-only'
      ? [
          '',
          'Cockpit 进阶示例：点击工具栏“现场问题”图标 → 打开左下附着面板 → 点击“上报问题” → 在宿主弹窗提交。',
          '现场问题数据保存在 Entry 内存中，用于演示工具栏入口、附着面板与 `platform:dialog` 宿主弹窗的完整交互。',
          ...(manifestKind === 'frontend-basic'
            ? ['入门示例：点击“打开示例面板”按钮，在左侧停靠面板查看计数器 View。']
            : []),
        ]
      : []),
    '',
    '## 工程边界',
    '',
    '- `src/plugin.ts` 是唯一 Plugin Entry，不导入 Vue 或访问 DOM。',
    '- `src/views/` 下每个目录都是独立 Vue 3 View，通过 typed channel 与 Entry 通信。',
    '- `src/generated/plugin-types.ts` 由 Toolchain 生成，请勿手改。',
    '- Source Manifest 只声明结构信息；构建字段由 Toolchain 写入 `dist/fh2-plugin.json`。',
    '- 使用 VS Code 编辑 `fh2-plugin.json` 时会自动加载 JSON Schema 提示（`.vscode/settings.json` 关联到 SDK 内置 Schema，完成依赖安装后生效）。',
    '- `pack` 由包含该插件的行业包统一执行，不在独立插件工程内运行。',
    '- `preview` 访问真实环境并常驻，先单独确认授权；只替换本地前端，后端仍使用目标环境已安装版本。报告不保存会话 URL、Token、Cookie 或私钥，用完恢复本次代理设置。',
    ...(input.packageManager === 'yarn' ? ['', '当前模板支持 Yarn Classic 1.22.x。'] : []),
    '',
  ].join('\n')
}

function createCapabilityReadme (input: CreateInput): string {
  const capabilityId = input.capabilityId!
  const frontendPluginId = input.frontendPluginId!
  const issuesPluginId = input.issuesPluginId!
  const backendPluginId = input.backendPluginId!
  const run = `${input.packageManager} run`
  return [
    `# ${input.name.trim()}`,
    '',
    `FH2 Capability 工程，Capability ID：\`${capabilityId}\`。后端是 TypeScript 引导示例，`
    + 'Handler、Event 与 Workflow Adapter 三种入口共用同一条记录生命周期（跑一圈的导览见 backend 内 README）。',
    '',
    '## 插件化开发者工具依赖',
    '',
    '先取得 https://github.com/dji-sdk/FlightHub-2-Plugin 的源码和固定 tag/commit，在源码根执行 `pnpm install --frozen-lockfile`，再执行 `pnpm link:toolchain`；Node 最低版本为 20.19。',
    '创建时使用该源码的 `packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs`，并传 `--platform-root <源码根>`。根和前端成员的依赖/覆盖只引用本地 `file:` SDK/Toolchain，不要求 FH2 公共 npm 包或私有 registry 登录。',
    'Toolchain 自带 `developer-runtime/` 运行投影；不另装完整 Contract，也不把它当后端 `knowledge import/use/status` 的项目知识锁。模板 `.npmrc` 留空，第三方依赖沿用你已有的 registry 配置。',
    '保留固定源码目录；移动或升级时先构建新版本源码，再核对所有 `file:` 路径和包管理器覆盖，显式重装、生成与校验，不自动改其他工程。',
    '',
    '## 目录',
    '',
    '```text',
    '<workspace>/',
    '├── packages.json',
    `└── ${capabilityId}/`,
    `    ├── frontend/${frontendPluginId}/`,
    `    ├── frontend/${issuesPluginId}/`,
    `    ├── backend/${backendPluginId}/`,
    '    ├── capabilities.json',
    '    └── mock/',
    '```',
    '',
    '工作区根的 `packages.json` 是平台上传清单（packageId + capabilityIds）；capability 内容住在同名子目录，与行业 Capability 工作区布局一致。',
    `${capabilityId}/frontend/${frontendPluginId} 是入门示例：Cockpit 工具栏按钮打开左侧示例面板。`,
    `${capabilityId}/frontend/${issuesPluginId} 是进阶示例：Cockpit 工具栏“现场问题”图标切换左下附着面板，面板内“上报问题”通过 \`platform:dialog\` 打开宿主弹窗。`,
    '',
    '## 有限质量命令',
    '',
    '```bash',
    `${input.packageManager} install`,
    `${run} generate`,
    `${run} validate`,
    `${run} build`,
    `${run} test`,
    '```',
    '',
    `以上 package scripts 在 Capability 工作区根执行，经 \`--root ${capabilityId}\` 指向 Capability 子目录；不要假定子目录有同名 scripts。`,
    '`validate` 会校验所有前端 Manifest，以及所有后端 Manifest、Workflow、Handler、Event 和 Adapter。',
    '`generate` 同时重生成前端 src/generated 与后端 Host 类型声明（改 allowlist 后使用；dev 会自动刷新）。',
    '`test` 只运行已有前端成员测试，不代表后端业务测试通过；后端成员没有自己的 package.json，修改业务仍需补聚焦测试。',
    '`backend/` 的 TS 源码会在 build 时经 esbuild 打成 Worker 可执行 Bundle；Handler 可使用点分名、驼峰兼容名或 h_ 名调用。',
    '`dev` 默认启动多前端 Workbench 和按 pluginId 隔离的本地后端 Runtime；可用 `dev:frontend` 或 `dev:backend` 收窄范围。',
    '后端本地跑一圈的 curl 导览（invoke / event / state）见 backend 内 README。',
    '',
    '## 调试与交付',
    '',
    `确认构建写入、端口与常驻进程后运行 \`${run} dev\`，使用本次完整打印地址；用完 Ctrl+C 停止并核对 watcher/端口清理。`,
    '两个前端示例的按钮和面板位于 Cockpit，默认团队页不显示。在在线设备卡点击“进入虚拟驾驶舱”图标，或打开设备小窗后点击“虚拟驾驶舱”按钮，在新页签查看示例。',
    `直接进入 Cockpit 时先停止已有 dev，再在外层工作区根运行 \`${run} dev:cockpit\`；该根脚本经 \`--root ${capabilityId}\` 调试整个 Capability。`,
    `在前端成员根运行 \`${run} dev:cockpit\` 使用成员自己的脚本，只调试该插件；不要假定任意子目录都会命中工作区根脚本。`,
    ...(input.packageManager === 'pnpm'
      ? ['pnpm 在无 `package.json` 的 `frontend/` 父目录可命中根脚本，在成员 `src/` 命中成员脚本；需要明确选择 pnpm 工作区根时，运行 `pnpm -w run dev:cockpit`。']
      : []),
    `旧工程若没有根 \`dev:cockpit\`，仍可在工作区根运行 \`${input.packageManager === 'pnpm' ? 'pnpm exec' : input.packageManager === 'npm' ? 'npm exec --' : 'yarn'} fh2-plugin dev cockpit --root ${capabilityId}\`，无需改写已有 scripts。`,
    `\`${run} preview\` 需另获真实环境和浏览器访问授权，只替换本地前端，后端仍使用目标司空环境已安装版本；用完恢复本次 PAC/代理，不保存含凭据的会话 URL。`,
    `\`${run} pack\` 可能重建并写交付物，先单独确认；生成带 \`packages.json\` 的未签名上传包，不生成 \`SIGNATURE\`，不自动签名、上传或部署。`,
    '`pack --no-build` 仅支持独立的默认配置 Build；使用 Watch、自定义配置或 Capability 外源码/配置依赖后必须重新 Build。',
    '',
  ].join('\n')
}

export const CREATE_CLI_METADATA: CliBehaviorMetadata = {
  behaviorKind: 'manual-description',
  contexts: [],
  exitCodes: [{ code: 0, meaning: '工程创建成功（--install 时含依赖安装与类型复验通过）' }, { code: 1, meaning: '创建失败：输入校验、模板写入、依赖安装或类型复验错误（参数错误也是 1）' }, { code: 130, meaning: '交互问答中被 Ctrl+C 取消' }],
  notes: ['不依赖工程上下文：在任意（空）目录创建新工程', '非交互模式：完整 Capability 至少提供项目目录；单插件必须提供项目目录与 --plugin-id'],
  source: 'src/create/run.ts#runCreatePlugin',
}
/** Human introduction plus options rendered from the production definition. */
export const CREATE_USAGE = `FH2 插件脚手架

用法：
  fh2-plugin create [项目目录] [选项]

默认生成完整 Capability（一能力、两前端、一后端 TypeScript 插件）；带 --plugin-id 且未指定模板时生成单插件。
非交互 Capability 至少提供项目目录；各 Plugin ID 默认由 Capability ID 派生。
交互模式会逐项询问（括号内为默认值，直接回车采用默认）。

${renderCliArguments(DEFINITION)}${renderCliOptions(DEFINITION)}`

function usage (): string {
  return CREATE_USAGE
}

function parsePackageManager (value: string): PackageManager {
  return parseCliOptionValue(DEFINITION.options.find(option => option.name === '--package-manager')!, value) as PackageManager
}

function parsePluginTemplate (value: string): PluginTemplate {
  return parseCliOptionValue(DEFINITION.options.find(option => option.name === '--template')!, value) as PluginTemplate
}

async function askPluginTemplate (ask: Ask, stderr: Writer): Promise<PluginTemplate> {
  while (true) {
    try {
      return parsePluginTemplate(await ask(
        '工程类型（0=完整 Capability，1=前端插件，2=后端插件）',
        String(cliDefault(DEFINITION, 'template', { mode: 'noninteractive' })),
      ))
    } catch (error) {
      if (isAbortError(error)) throw error
      stderr.write(`${errorMessage(error)}\n`)
    }
  }
}

function detectPackageManager (userAgent: string | undefined): PackageManager | undefined {
  if (!userAgent) return undefined
  if (userAgent.startsWith('pnpm/')) return 'pnpm'
  if (userAgent.startsWith('yarn/')) return 'yarn'
  if (userAgent.startsWith('npm/')) return 'npm'
  return undefined
}

function humanizeProjectName (name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function humanizePluginName (pluginId: string): string {
  return humanizeProjectName(pluginId.replace(/^(official|exp)_/, ''))
}

async function askPluginId (ask: Ask, stderr: Writer, defaultValue?: string): Promise<string> {
  while (true) {
    const pluginId = await ask(
      'Plugin ID（扩展插件使用 exp_ 前缀；例如 exp_workbench_demo）',
      defaultValue,
    )
    if (pluginIdPattern.test(pluginId)) return pluginId
    stderr.write('Plugin ID 不合法：扩展插件请使用 exp_ 前缀，官方插件使用 official_ 前缀；例如 exp_workbench_demo。\n')
  }
}

function suggestPluginId (directory: string): string {
  const normalized = basename(directory)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
  if (pluginIdPattern.test(normalized)) return normalized
  return `exp_${normalized || 'plugin'}`
}

function parseYes (value: string): boolean {
  return ['y', 'yes', '是'].includes(value.trim().toLowerCase())
}

async function readPackageVersion (packageRoot: string): Promise<string> {
  const source = await readFile(join(packageRoot, 'package.json'), 'utf8')
  const pkg = JSON.parse(source) as { version?: string }
  if (!pkg.version) throw new CreatePluginError('无法读取 fh2-plugin-toolchain 版本。')
  return pkg.version
}

async function findPlatformRepositoryRoot (
  cwd: string,
  explicitRoot?: string,
  toolchainPackageRoot?: string,
): Promise<string | undefined> {
  if (explicitRoot !== undefined) {
    const root = resolve(cwd, explicitRoot)
    if (await isPlatformRepositoryRoot(root)) return root
    throw new CreatePluginError(`--platform-root 不是有效的 fh2-plugin-platform 仓根：${root}`)
  }

  const cwdRoot = await findPlatformRepositoryRootFrom(cwd)
  if (cwdRoot !== undefined) return cwdRoot
  if (toolchainPackageRoot !== undefined)
    return await findPlatformRepositoryRootFrom(toolchainPackageRoot)
  return undefined
}

async function findPlatformRepositoryRootFrom (start: string): Promise<string | undefined> {
  let candidate = resolve(start)
  while (true) {
    if (await isPlatformRepositoryRoot(candidate)) return candidate
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
}

async function isPlatformRepositoryRoot (root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: string }
    return pkg.name === 'fh2-plugin-platform'
      && existsSync(join(root, 'examples'))
      && existsSync(join(root, 'packages', 'fh2-plugin-sdk', 'package.json'))
      && existsSync(join(root, 'packages', 'fh2-plugin-toolchain', 'package.json'))
  } catch {
    return false
  }
}

function localPackageSpec (
  platformRepositoryRoot: string | undefined,
  targetDir: string,
  packageDirectory: string,
): string | undefined {
  if (platformRepositoryRoot === undefined) return undefined
  // macOS 的 /tmp 常映射到 /private/tmp。file: 相对路径必须以包管理器实际解析到的
  // 物理路径为基准，避免临时目录别名让跨目录的 file: 依赖解析到错误位置。
  const path = relative(
    canonicalPath(targetDir),
    realpathSync(join(platformRepositoryRoot, 'packages', packageDirectory)),
  ).split(sep).join('/')
  return `file:${path.startsWith('.') ? path : `./${path}`}`
}

function canonicalPath (path: string): string {
  const missing: string[] = []
  let candidate = resolve(path)
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) return resolve(path)
    missing.unshift(basename(candidate))
    candidate = parent
  }
  return resolve(realpathSync(candidate), ...missing)
}

/**
 * 未发布基线守卫：只有 CI 发布流程会在打包前给 package.json 写入
 * `fh2.published = true`；本地源码与手工 pnpm pack 的 tarball 均无该标记。
 * 仓外运行时无标记的 Toolchain 写出的精确依赖版本无法从 registry 解析。
 * 仅供 create 与其单测使用，不是 Toolchain 公开 API。
 *
 * @internal
 */
export function isUnpublishedSourceBaseline (toolchainPackageRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(toolchainPackageRoot, 'package.json'), 'utf8')) as {
      fh2?: { published?: boolean };
    }
    return pkg.fh2?.published !== true
  } catch {
    return true
  }
}

function writeDependencySourceNotice (
  stderr: Writer,
  options: {
    readonly platformRepositoryRoot?: string;
    readonly sdkVersion: string;
    readonly toolchainVersion: string;
  },
): void {
  if (options.platformRepositoryRoot !== undefined) {
    stderr.write(`[fh2-plugin create] 依赖来源：本地平台仓 ${options.platformRepositoryRoot}\n`)
    stderr.write('[fh2-plugin create] SDK/Toolchain 将以 file: 相对路径写入生成工程。\n')
    return
  }
  stderr.write(`[fh2-plugin create] 依赖来源：已发布包（SDK ${options.sdkVersion}；Toolchain ${options.toolchainVersion}）。\n`)
}

function resolvePackageRoot (sourceFile: string): string {
  let directory = dirname(sourceFile)
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error('无法定位 fh2-plugin-toolchain 包根目录。')
    directory = parent
  }
  return directory
}

async function readInstalledPackageVersion (packageRoot: string, packageName: string): Promise<string> {
  const require = createRequire(join(packageRoot, 'package.json'))
  const packageJson = require.resolve(`${packageName}/package.json`)
  const source = await readFile(packageJson, 'utf8')
  const pkg = JSON.parse(source) as { version?: string }
  if (!pkg.version) throw new CreatePluginError(`无法读取 ${packageName} 版本。`)
  return pkg.version
}

async function writeJson (file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function pathExists (path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * 包管理器 spawn 形态：Windows 的 npm/pnpm/yarn 是 .cmd shim（无 .exe），
 * Node ≥ 20.12 起不带 shell 直接 spawn `.cmd` 会抛 EINVAL（CVE-2024-27980），
 * 须经 cmd.exe 按 PATHEXT 解析并逐参数加引号；POSIX 保持直启。导出供单测。
 */
export function packageManagerSpawnPlan (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { command, args: [...args], shell: false }
  return { command, args: args.map(value => quoteShellArg(value, 'win32')), shell: true }
}

async function runPackageManagerCommand (command: string, args: readonly string[], cwd: string): Promise<void> {
  const plan = packageManagerSpawnPlan(command, args)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, { cwd, stdio: 'inherit', shell: plan.shell })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(signal ? `${command} 被信号 ${signal} 终止` : `${command} 退出码 ${code ?? 'unknown'}`))
    })
  })
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError (error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isNodeError (error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
