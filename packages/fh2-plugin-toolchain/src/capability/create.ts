// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { PluginManifest } from 'fh2-plugin-sdk'
import type { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import { generatePluginTypes as generateBackendPluginTypes } from '../backend/typegen/plugin-types.js'
import { validateBackendSourcePlugin } from '../backend/source-contract.js'
import { DEPENDENCY_BUILD_POLICY } from '../dependency-build-policy.js'

/** hello 示例需要裁剪的 issue 示例文件（相对前端插件根）。 */
const ISSUE_EXAMPLE_FILES = [
  'src/hosts/cockpit/issue-example.ts',
  'src/views/issue-panel',
  'src/views/issue-dialog',
  'public/icons/issue.svg',
  'public/icons/issue-active.svg',
  'tests/issue-activate.test.ts',
] as const

/** issue 示例需要裁剪的 hello 示例文件（相对前端插件根）。 */
const HELLO_EXAMPLE_FILES = [
  'src/hosts/cockpit/hello-example.ts',
  'src/views/hello-panel',
  'tests/resource-cleanup.test.ts',
] as const

export interface CapabilityFrontendPlugin {
  readonly pluginId: string;
  readonly variant: 'hello' | 'issues';
  readonly manifest: PluginManifest;
  readonly packageJson: object;
  readonly readme: string;
}

export interface CreateCapabilityWorkspaceOptions {
  readonly targetDir: string;
  readonly packageRoot: string;
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly capabilityDescription: string;
  readonly frontendPluginId: string;
  readonly issuesPluginId: string;
  readonly backendPluginId: string;
  readonly frontendPlugins: readonly CapabilityFrontendPlugin[];
  readonly rootPackageJson: object;
  readonly rootReadme: string;
  /** 平台上传包清单内容（packages.json 序列化结果）。 */
  readonly packagesManifest: string;
  readonly pnpmOverrides?: Record<string, string>;
  readonly generateTypes: typeof generatePluginTypes;
}

export class CapabilityCreateError extends Error {
  constructor (message: string, readonly projectPreserved = false) {
    super(message)
    this.name = 'CapabilityCreateError'
  }
}

export async function createCapabilityWorkspace (options: CreateCapabilityWorkspaceOptions): Promise<void> {
  const targetExisted = await pathExists(options.targetDir)
  const parentDir = dirname(options.targetDir)
  await mkdir(parentDir, { recursive: true })
  const stagingDir = await mkdtemp(join(parentDir, `.${basename(options.targetDir)}.fh2-create-`))
  let stagingCommitted = false

  try {
    // 工作区根 -> packages.json/package.json/pnpm-workspace.yaml/README；
    // capability 内容（capabilities.json/frontend/backend/mock）住 capability 子目录，
    // 与 packages/fh2-traffic-capabilities 的行业工作区布局一致。
    const capabilityDir = join(stagingDir, options.capabilityId)
    const backendRoot = join(capabilityDir, 'backend', options.backendPluginId)
    await mkdir(capabilityDir, { recursive: true })
    await cp(join(options.packageRoot, 'template-capability', 'mock'), join(capabilityDir, 'mock'), { recursive: true })
    await cp(join(options.packageRoot, 'template-capability', '_gitignore'), join(stagingDir, '_gitignore'))
    await cp(join(options.packageRoot, 'template-capability', '_npmrc'), join(stagingDir, '_npmrc'))
    await mkdir(dirname(backendRoot), { recursive: true })
    await cp(join(options.packageRoot, 'template-backend'), backendRoot, { recursive: true })
    await normalizeTemplateDotfiles(stagingDir)

    await writeJson(join(capabilityDir, 'capabilities.json'), {
      name: options.capabilityName,
      description: options.capabilityDescription,
    })
    await writeFile(join(stagingDir, 'packages.json'), options.packagesManifest, 'utf8')
    await writeJson(join(stagingDir, 'package.json'), options.rootPackageJson)
    await writeFile(
      join(stagingDir, 'pnpm-workspace.yaml'),
      formatPnpmWorkspace({
        packages: [`${options.capabilityId}/frontend/*`],
        ...(options.pnpmOverrides === undefined ? {} : { overrides: options.pnpmOverrides }),
        ...DEPENDENCY_BUILD_POLICY,
      }),
      'utf8',
    )
    await writeFile(join(stagingDir, 'README.md'), options.rootReadme, 'utf8')

    for (const plugin of options.frontendPlugins) {
      const frontendRoot = join(capabilityDir, 'frontend', plugin.pluginId)
      await mkdir(dirname(frontendRoot), { recursive: true })
      await cp(join(options.packageRoot, 'template'), frontendRoot, { recursive: true })
      await normalizeTemplateDotfiles(frontendRoot)
      await trimTemplateExample(frontendRoot, plugin.variant)
      await writeFile(
        join(frontendRoot, 'src/hosts/cockpit/activate.ts'),
        await readFile(
          join(options.packageRoot, 'template-variants', plugin.variant === 'hello' ? 'activate-hello-only.ts' : 'activate-issues-only.ts'),
          'utf8',
        ),
        'utf8',
      )
      await writeJson(join(frontendRoot, 'fh2-plugin.json'), plugin.manifest)
      await writeJson(join(frontendRoot, 'package.json'), plugin.packageJson)
      await writeFile(join(frontendRoot, 'README.md'), plugin.readme, 'utf8')

      try {
        const generated = options.generateTypes({
          manifest: plugin.manifest,
          outDir: join(frontendRoot, 'src/generated'),
        })
        const generatedFile = join(frontendRoot, 'src/generated', generated.fileName)
        await mkdir(dirname(generatedFile), { recursive: true })
        await writeFile(generatedFile, generated.source, 'utf8')
      } catch (error) {
        if (targetExisted) await rmdir(options.targetDir)
        await rename(stagingDir, options.targetDir)
        stagingCommitted = true
        throw new CapabilityCreateError(`插件 ${plugin.pluginId} 首次类型生成失败：${message(error)}`, true)
      }
    }

    // 占位符出现在 plugin.json、schema.sql 头注释与 README 的示例命令里 —— 三处都换，
    // 漏一处的表现是"示例命令里的 pluginId 对不上"，而那正是引导示例最忌讳的。
    for (const file of ['fh2-plugin.json', 'schema.sql', 'README.md']) {
      const path = join(backendRoot, file)
      if (!existsSync(path)) continue
      const source = await readFile(path, 'utf8')
      await writeFile(path, source
        .replaceAll('__BACKEND_PLUGIN_ID__', options.backendPluginId)
        .replaceAll('__BACKEND_PLUGIN_NAME__', `${options.capabilityName} 后端`), 'utf8')
    }
    const backendValidation = validateBackendSourcePlugin(backendRoot)
    if (!backendValidation.ok) {
      throw new CapabilityCreateError(
        `后端插件 Worker 契约校验失败：${backendValidation.diagnostics.map(item => `${item.code}: ${item.message}`).join('；')}`,
      )
    }

    // 后端 types/ 随模板携带,但按当前清单与源码 import 图现生成一遍:
    // 模板与生成器谁漂了都会在这里暴露,而不是等到用户第一次跑 fh2-plugin types --check。
    await regenerateBackendTypes(backendRoot)

    if (targetExisted) await rmdir(options.targetDir)
    await rename(stagingDir, options.targetDir)
    stagingCommitted = true
  } finally {
    if (!stagingCommitted) await rm(stagingDir, { recursive: true, force: true })
  }
}

async function trimTemplateExample (frontendRoot: string, variant: 'hello' | 'issues'): Promise<void> {
  const removedFiles = variant === 'hello' ? ISSUE_EXAMPLE_FILES : HELLO_EXAMPLE_FILES
  for (const file of removedFiles) {
    await rm(join(frontendRoot, file), { recursive: true, force: true })
  }
}

/** 按当前清单与源码 import 图重写 types/（与 fh2-plugin types 同一产物；capability 与单后端插件工程共用）。 */
export async function regenerateBackendTypes (backendRoot: string): Promise<void> {
  const result = generateBackendPluginTypes(backendRoot)
  const typesDir = join(backendRoot, 'types')
  await mkdir(typesDir, { recursive: true })
  for (const [file, source] of result.files) {
    await writeFile(join(typesDir, file), source, 'utf8')
  }
  // 生成器不再产出的旧文件会留在 types/ 里污染 tsconfig —— 与 types --check 同口径清掉。
  for (const stale of ['entities.d.ts', 'storage.ts', 'shared-all.d.ts', 'shared-call.d.ts', 'shared-adapter.d.ts', 'call.d.ts', 'handler.d.ts', 'event.d.ts', 'adapter.d.ts']) {
    if (result.files.has(stale)) continue
    await rm(join(typesDir, stale), { force: true })
  }
}

async function normalizeTemplateDotfiles (root: string): Promise<void> {
  for (const [source, target] of [
    ['_gitignore', '.gitignore'],
    ['_npmrc', '.npmrc'],
    ['_vscode', '.vscode'],
  ] as const) {
    const sourcePath = join(root, source)
    try {
      await stat(sourcePath)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue
      throw error
    }
    await rename(sourcePath, join(root, target))
  }
}

async function writeJson (file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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
    for (const [name, spec] of Object.entries(options.overrides)) lines.push(`  '${name}': ${spec}`)
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

async function pathExists (path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function isNodeError (error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
