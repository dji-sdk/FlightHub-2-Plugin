#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { assetError, readAssetJson } from '../../packages/fh2-plugin-toolchain/scripts/copy-workbench.mjs'
import { runSourceCommand } from './build.mjs'
import { checkSource, parseSourceArguments, reportSourceError, sourcePaths } from './check.mjs'

/** junction 的 readlink 返回 `\\?\` 前缀的设备路径，剥掉才能与普通路径比较。UNC 形态还原为 `\\server\share`。 */
export function stripWindowsDevicePrefix (value) {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`
  return value.startsWith('\\\\?\\') ? value.slice(4) : value
}

export function linkSource ({ sourceRoot, prefix, replaceExisting = false, unlink = false, env = process.env, spawn = spawnSync, stdout = process.stdout, platform = process.platform, verifySource = checkSource } = {}) {
  if (unlink && replaceExisting) throw Object.assign(assetError('FH2_SOURCE_ARGUMENT', '--unlink 与 --replace-existing 不能同时使用。'), { exitCode: 2 })
  const paths = sourcePaths(sourceRoot)
  const toolchain = readAssetJson(join(paths.packageRoot, 'package.json'))
  if (toolchain.name !== 'fh2-plugin-toolchain') throw assetError('FH2_SOURCE_LAYOUT', '源码目录不是 FH2 Toolchain 包。')
  const bin = toolchain.bin?.['fh2-plugin']
  if (typeof bin !== 'string' || Object.keys(toolchain.bin).length !== 1 || isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) {
    throw assetError('FH2_LINK_BIN', 'Toolchain 没有有效的 fh2-plugin bin 入口。', 'packages/fh2-plugin-toolchain/package.json')
  }
  if (!unlink) {
    verifySource({ sourceRoot: paths.sourceRoot })
    for (const file of [join(paths.packageRoot, bin), join(paths.packageRoot, 'dist/cli.js'), join(paths.sdkRoot, 'dist/index.js'), join(paths.packageRoot, 'apps/fh2-web-ide/dist/index.html'), join(paths.packageRoot, 'apps/mock-host-workbench-shell/dist/index.html'), join(paths.packageRoot, 'apps/mock-host-vue2/dist/container.html'), join(paths.packageRoot, 'apps/mock-host-vue3/dist/container.html')]) {
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
        throw assetError('FH2_LINK_BUILD_REQUIRED', '构建产物缺失；先运行 pnpm build:tooling，不能注册半成品。', relative(paths.sourceRoot, file).split(sep).join('/'))
      }
    }
  }
  if (prefix !== undefined) prefix = resolve(prefix)
  const linkEnv = prefix === undefined ? env : { ...env, npm_config_prefix: prefix }
  const options = { cwd: paths.packageRoot, env: linkEnv, spawn, stdout }
  const result = runSourceCommand('npm', ['prefix', '--global'], { ...options, capture: true })
  const globalPrefix = result.stdout?.trim()
  if (!globalPrefix || !isAbsolute(globalPrefix) || globalPrefix.includes('\n') || globalPrefix.includes('\r')) {
    throw assetError('FH2_LINK_PREFIX', 'npm 没有返回有效的全局 prefix；未执行注册。')
  }
  const globalPackage = join(globalPrefix, platform === 'win32' ? 'node_modules' : 'lib/node_modules', toolchain.name)
  const globalBin = join(globalPrefix, platform === 'win32' ? '' : 'bin', 'fh2-plugin')
  const binPaths = platform === 'win32' ? [globalBin, `${globalBin}.cmd`, `${globalBin}.ps1`] : [globalBin]
  const realTarget = (path) => {
    try {
      return fs.realpathSync(path)
    } catch {
      return undefined
    }
  }
  const registeredRoot = realTarget(globalPackage)
  const linkTarget = (path) => {
    if (!fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined
    const target = fs.readlinkSync(path)
    return resolve(dirname(path), platform === 'win32' ? stripWindowsDevicePrefix(target) : target)
  }
  // Windows npm link 产出的是普通文件 cmd-shim（sh/.cmd/.ps1），不是符号链接；
  // 归属判定读内容里对全局 node_modules/<包名> 的引用。
  const shimReferencesPackage = (path) => {
    const entry = fs.lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined || !entry.isFile()) return false
    try {
      return fs.readFileSync(path, 'utf8').replaceAll('\\', '/').includes(`node_modules/${toolchain.name}/`)
    } catch {
      return false
    }
  }
  const binLinksToPair = danglingRootValue => platform === 'win32'
    ? binPaths.every(path => shimReferencesPackage(path))
    : binPaths.every(path => linkTarget(path) === resolve(danglingRootValue, bin) || linkTarget(path) === resolve(globalPackage, bin))
  const danglingRoot = registeredRoot === undefined ? linkTarget(globalPackage) : undefined
  // Missing metadata is recoverable only for a paired package/bin link to the source layout.
  const danglingPair = danglingRoot !== undefined && !fs.lstatSync(danglingRoot, { throwIfNoEntry: false })
    && basename(danglingRoot) === basename(paths.packageRoot) && basename(dirname(danglingRoot)) === 'packages'
    && binLinksToPair(danglingRoot)
  const conflicts = [globalPackage, ...binPaths].filter((path) => {
    const entry = fs.lstatSync(path, { throwIfNoEntry: false })
    if (!entry) return false
    if (platform === 'win32') {
      if (path === globalPackage) return realTarget(path) !== paths.packageRoot
      // cmd-shim 是普通文件；内容引用本包即视为我们的注册产物
      return !shimReferencesPackage(path)
    }
    const target = realTarget(path)
    return target === undefined || (path !== globalPackage && !entry.isSymbolicLink())
      || target !== (path === globalPackage ? paths.packageRoot : realTarget(join(paths.packageRoot, bin)))
  })
  if (unlink) {
    if (conflicts.length > 0) {
      throw assetError('FH2_UNLINK_NOT_OWNED', danglingPair
        ? '全局注册指向已移动的旧源码；未解除它。可用 --replace-existing 显式恢复 FH2 注册，或使用隔离 --prefix。'
        : '全局注册不属于当前源码；未解除其他版本或工具。')
    }
    if (!registeredRoot && !binPaths.some(path => fs.lstatSync(path, { throwIfNoEntry: false }))) {
      stdout.write('当前源码没有全局注册，无需解除。\n')
      return { prefix: globalPrefix, packageRoot: paths.packageRoot }
    }
  }
  if (conflicts.length > 0) {
    if (!replaceExisting) throw assetError('FH2_LINK_CONFLICT', '已有全局 fh2-plugin 或同名包；未覆盖。确认替换后使用 --replace-existing，或指定隔离 --prefix。')
    const unrelated = platform === 'win32'
      // Windows：安全替换 = globalPackage junction 指向当前源码，且已存在的 shim 都引用本包。
      // 真实目录（npm install -g 的拷贝）或外部工具的 shim 一律拒绝，不自动删除。
      ? !danglingPair && (realTarget(globalPackage) !== paths.packageRoot
        || binPaths.some(path => fs.lstatSync(path, { throwIfNoEntry: false }) && !shimReferencesPackage(path)))
      : !danglingPair && (!registeredRoot || !fs.lstatSync(registeredRoot).isDirectory()
        || !fs.lstatSync(join(registeredRoot, 'package.json'), { throwIfNoEntry: false })?.isFile()
        || readAssetJson(join(registeredRoot, 'package.json')).name !== toolchain.name
        || binPaths.some(path => fs.lstatSync(path, { throwIfNoEntry: false }) && (!fs.lstatSync(path).isSymbolicLink() || !realTarget(path)
          || relative(registeredRoot, realTarget(path)).split(sep)[0] === '..' || isAbsolute(relative(registeredRoot, realTarget(path))))))
    if (unrelated) throw assetError('FH2_LINK_UNRELATED', 'fh2-plugin 路径属于未知文件或其他全局工具；请使用隔离 --prefix，不自动删除它。')
    stdout.write(danglingPair
      ? '将替换已确认配对的悬空 FH2 全局链接；其他全局包不由本脚本修改。\n'
      : '将替换已有的同名 FH2 Toolchain 全局注册；其他全局包不由本脚本修改。\n')
  }
  try {
    if (danglingPair && replaceExisting) {
      // npm cannot always replace a dangling direct-source bin link. Unlink only this verified pair.
      if (linkTarget(globalPackage) !== danglingRoot || !binLinksToPair(danglingRoot)) {
        throw assetError('FH2_LINK_CONFLICT', '全局链接在确认后已变化；未继续替换。')
      }
      for (const path of [...binPaths, globalPackage]) fs.unlinkSync(path)
    }
    runSourceCommand('npm', [unlink ? 'unlink' : 'link', ...(unlink ? ['--global', toolchain.name] : []), '--no-audit', '--no-fund', '--ignore-scripts'], options)
  } catch (error) {
    error.message += ' 请确认全局 prefix 可写，或用 --prefix 指定可写目录并加入 PATH；脚本不修改全局 npm 配置。'
    throw error
  }
  stdout.write(unlink
    ? '已解除当前源码的全局注册，工程和固定资源未删除；不会自动恢复此前的 npm 安装。\n'
    : `当前源码 Toolchain 已注册为全局 fh2-plugin。请确认 ${platform === 'win32' ? globalPrefix : join(globalPrefix, 'bin')} 位于 PATH；工程内优先使用本地 CLI。\n`)
  return { prefix: globalPrefix, packageRoot: paths.packageRoot }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseSourceArguments(process.argv.slice(2), { prefix: { type: 'string' }, 'replace-existing': { type: 'boolean' }, unlink: { type: 'boolean' } })
    if (args.help) process.stdout.write('用法：node scripts/public-source/link.mjs [--root <源码根>] [--prefix <可写全局目录>] [--replace-existing | --unlink]\n只注册已完成的构建，不自动构建、不修改全局配置，不静默覆盖已有 CLI；--unlink 只解除当前源码的注册。\n')
    else linkSource({ sourceRoot: args.root, prefix: args.prefix, replaceExisting: args['replace-existing'], unlink: args.unlink })
  } catch (error) {
    process.exitCode = reportSourceError(error)
  }
}
