#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import fs from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  assetError,
  readAssetJson,
  verifyFileManifest,
  verifyMockHostAssets,
} from '../../packages/fh2-plugin-toolchain/scripts/copy-workbench.mjs'

export const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function sourcePaths (sourceRoot = defaultSourceRoot) {
  sourceRoot = fs.realpathSync(sourceRoot)
  return {
    sourceRoot,
    packageRoot: join(sourceRoot, 'packages/fh2-plugin-toolchain'),
    sdkRoot: join(sourceRoot, 'packages/fh2-plugin-sdk'),
  }
}

const NOISE_ENTRY = /^(\.DS_Store|\._.+|Thumbs\.db|desktop\.ini)$/i

/** 公开树不允许 Finder/资源管理器产生的系统噪声；它们会让交付包显得不专业。 */
function assertNoSystemNoise (root) {
  const offenders = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = join(directory, entry.name)
      if (NOISE_ENTRY.test(entry.name) || entry.name === '__MACOSX') {
        offenders.push(relative(root, absolute))
        continue
      }
      if (entry.isDirectory()) walk(absolute)
    }
  }
  walk(root)
  if (offenders.length > 0) {
    throw assetError('FH2_SOURCE_SYSTEM_NOISE', `公开树包含系统噪声文件（${offenders.length} 个）：${offenders.slice(0, 5).join('、')}`, offenders[0])
  }
}

const README_REQUIRED = ['# FH2 插件开发工具包', '**许可**']

/** 公开树 README 是导出时原样冻结的；英文版曾随旧输入进过公开包，这里守住语言和结构。 */
export function assertPublicReadme (root) {
  const file = join(root, 'README.md')
  // 真实候选一定有 README（prepare 要求显式非空输入）；单元夹具可以不带。
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  const missing = README_REQUIRED.filter(marker => !text.includes(marker))
  if (missing.length > 0 || !/[\u4E00-\u9FFF]/.test(text)) {
    throw assetError('FH2_SOURCE_README_LANGUAGE', `公开树 README 不是中文发行说明，缺少：${missing.join('、') || '中文内容'}。`, 'README.md')
  }
}

export function checkSource ({ sourceRoot = defaultSourceRoot, expectedResourceDigest, expectedProjectionDigest, requireDistribution = true } = {}) {
  const { sourceRoot: root, packageRoot, sdkRoot } = sourcePaths(sourceRoot)
  assertNoSystemNoise(root)
  const distributionPath = join(root, 'public-distribution.json')
  if (fs.lstatSync(distributionPath, { throwIfNoEntry: false })) {
    assertPublicReadme(root)
    // Author edits are allowed; only immutable data/resource inputs stay bound to the release.
    const distribution = readAssetJson(distributionPath)
    for (const [key, expected] of [['resourceDigest', expectedResourceDigest], ['projectionDigest', expectedProjectionDigest]]) {
      if (!/^sha256:[a-f0-9]{64}$/.test(distribution?.[key] ?? '') || (expected !== undefined && expected !== distribution[key])) {
        throw assetError('FH2_SOURCE_INPUT_DIGEST', '固定运行输入摘要与发行记录或指定摘要不匹配。', 'public-distribution.json')
      }
    }
    expectedResourceDigest ??= distribution.resourceDigest
    expectedProjectionDigest ??= distribution.projectionDigest
  } else if (requireDistribution && (!/^sha256:[a-f0-9]{64}$/.test(expectedResourceDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedProjectionDigest ?? ''))) {
    throw assetError('FH2_SOURCE_DISTRIBUTION_REQUIRED', '缺少发行清单；公开构建必须绑定 public-distribution.json，或显式提供资源和投影两项预期摘要。', 'public-distribution.json')
  }
  const packages = [root, sdkRoot, packageRoot].map(directory => ({ directory, manifest: readAssetJson(join(directory, 'package.json')) }))
  if (packages[0].manifest.name !== 'fh2-plugin-platform'
    || packages[1].manifest.name !== 'fh2-plugin-sdk'
    || packages[2].manifest.name !== 'fh2-plugin-toolchain') {
    throw assetError('FH2_SOURCE_LAYOUT', '源码目录必须包含精选布局中的平台根、SDK 和 Toolchain。', 'package.json')
  }
  const localPackages = new Map(packages.slice(1).map(pkg => [pkg.manifest.name, pkg.directory]))
  for (const pkg of packages) {
    const groups = [pkg.manifest.dependencies, pkg.manifest.devDependencies, pkg.manifest.optionalDependencies, pkg.manifest.peerDependencies, pkg.manifest.pnpm?.overrides, pkg.manifest.overrides, pkg.manifest.resolutions]
    for (const group of groups) {
      for (const [name, value] of Object.entries(group ?? {})) {
        const path = relative(root, join(pkg.directory, 'package.json')).split(sep).join('/')
        if (typeof value !== 'string') throw assetError('FH2_SOURCE_DEPENDENCY', '依赖声明必须使用明确的版本或本地路径。', path)
        if (/@(?:4f2e|fh2)\/(?:fh2-plugin-(?:engine|contract(?:-model)?|dev-skill)|mock-host-)/.test(`${name} ${value}`)) {
          throw assetError('FH2_SOURCE_PRIVATE_DEPENDENCY', '公开构建不能依赖 Engine、完整 Contract 或私有 Mock Host 包。', path)
        }
        // 下一行出现的 @4f2e 字面量是依赖边界守卫的检测目标本身（防内部 scope 混入公开构建），
        // 不是对内部包的引用；公开树不含任何 @4f2e 实际依赖。
        if ((name.startsWith('@4f2e/') && !localPackages.has(name)) || value.includes('@4f2e/')) {
          throw assetError('FH2_SOURCE_PRIVATE_DEPENDENCY', 'FH2 构建依赖不能指向未交付包或远端 npm 别名。', path)
        }
        if (localPackages.has(name)) {
          const local = value.startsWith('file:') ? resolve(pkg.directory, value.slice(5)) : undefined
          if (value !== 'workspace:*' && local !== localPackages.get(name)) {
            throw assetError('FH2_SOURCE_DEPENDENCY', 'FH2 SDK/Toolchain 必须引用精选 workspace 或对应的本地 file: 包。', path)
          }
        } else if (/^(?:workspace|file|link):/.test(value)) {
          throw assetError('FH2_SOURCE_PRIVATE_DEPENDENCY', '构建依赖指向精选构建范围之外的 workspace。', path)
        }
      }
    }
  }
  const runtime = verifyFileManifest({
    directory: join(packageRoot, 'developer-runtime'),
    kind: 'fh2-developer-runtime',
    digestField: 'projectionDigest',
    expectedDigest: expectedProjectionDigest,
  })
  const required = ['backend.json', 'knowledge.json', 'resources.json', 'schemas/backend-plugin-runtime.schema.json', 'schemas/backend-plugin-source.schema.json', 'schemas/workflow.schema.json'].sort()
  if (JSON.stringify(runtime.files.map(file => file.path)) !== JSON.stringify(required)
    || !/^sha256:[a-f0-9]{64}$/.test(runtime.sourceBackendDigest ?? '')
    || !Number.isSafeInteger(runtime.publishedEntries) || runtime.publishedEntries < 0
    || runtime.sourceVersions === null || typeof runtime.sourceVersions !== 'object' || Array.isArray(runtime.sourceVersions)) {
    throw assetError('FH2_SOURCE_RUNTIME_FORMAT', '开发者运行数据清单缺少必需文件或来源字段。', 'developer-runtime/manifest.json')
  }
  for (const file of runtime.files) readAssetJson(join(packageRoot, 'developer-runtime', file.path))
  const resources = verifyMockHostAssets({ packageRoot, sdkRoot, expectedResourceDigest })
  return {
    kind: 'fh2-public-source-check',
    formatVersion: 1,
    versions: { sdk: resources.versions.sdk, toolchain: resources.versions.toolchain },
    projectionDigest: runtime.projectionDigest,
    resourceDigest: resources.resourceDigest,
    inputSourceDigest: resources.inputSourceDigest,
  }
}

export function parseSourceArguments (args, options = {}) {
  try {
    const parsed = parseArgs({ args, options: { root: { type: 'string' }, help: { type: 'boolean' }, ...options }, allowPositionals: false, tokens: true })
    const names = new Set()
    for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
      if (names.has(token.name) || token.value === '') throw new Error('invalid option')
      names.add(token.name)
    }
    return parsed.values
  } catch {
    throw Object.assign(assetError('FH2_SOURCE_ARGUMENT', '参数缺失或无效；使用 --help 查看支持的参数。'), { exitCode: 2 })
  }
}

export function reportSourceError (error, stderr = process.stderr) {
  const message = error.exitCode === undefined ? '操作失败，请检查目录、依赖和权限。' : error.message
  stderr.write(`[${error.code ?? 'FH2_SOURCE_FAILED'}] ${message}${error.path ? ` (${error.path})` : ''}\n`)
  return error.exitCode ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let format = 'text'
  try {
    const args = parseSourceArguments(process.argv.slice(2), {
      format: { type: 'string', default: 'text' },
      'resource-digest': { type: 'string' },
      'projection-digest': { type: 'string' },
    })
    format = args.format
    if (!['text', 'json'].includes(format)) throw Object.assign(assetError('FH2_SOURCE_ARGUMENT', '--format 只支持 text 或 json。'), { exitCode: 2 })
    for (const key of ['resource-digest', 'projection-digest']) {
      if (args[key] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(args[key])) {
        throw Object.assign(assetError('FH2_SOURCE_ARGUMENT', '指定摘要必须是 sha256: 加 64 位小写 hex。'), { exitCode: 2 })
      }
    }
    if (args.help) {
      process.stdout.write('用法：node scripts/public-source/check.mjs [--root <源码根>] [--format text|json] [--resource-digest <sha256:...>] [--projection-digest <sha256:...>]\n固定输入必须绑定发行清单；缺少清单时需显式提供两项预期摘要。不检查作者源码的发行摘要，也不使用 Git。\n')
    } else {
      const report = checkSource({ sourceRoot: args.root, expectedResourceDigest: args['resource-digest'], expectedProjectionDigest: args['projection-digest'] })
      process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : '源码的固定运行数据和 Mock Host 资源校验通过。\n')
    }
  } catch (error) {
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify({ diagnostics: [{ code: error.code ?? 'FH2_SOURCE_FAILED', severity: 'error', ...(error.path ? { path: error.path } : {}), message: error.exitCode === undefined ? '源码检查失败。' : error.message }] }, null, 2)}\n`)
      process.exitCode = error.exitCode ?? 1
    } else {
      process.exitCode = reportSourceError(error)
    }
  }
}
