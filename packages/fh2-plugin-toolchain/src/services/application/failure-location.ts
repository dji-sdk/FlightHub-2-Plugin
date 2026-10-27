// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { PROJECT_PATHS } from '../../project-policy.js'

/** 仅在命令已经失败时解释位置，不参与 discovery、取锁或输入接受范围。 */
export function failureLocationHint (command: string, rawRoot: string): string {
  const root = resolve(rawRoot)
  try {
    let stat
    try {
      stat = statSync(root)
    } catch (error) {
      if (!isMissingPathError(error)) return ''
      return `位置提示：目标目录不存在：${root}\n请检查 --root；省略时使用当前目录。原始诊断保留如下。\n`
    }
    if (!stat.isDirectory()) {
      return `位置提示：目标不是目录：${root}\n请将 --root 指向工程目录。原始诊断保留如下。\n`
    }
    if (hasPath(join(root, PROJECT_PATHS.sourceManifest))) return ''
    if (hasPath(join(root, PROJECT_PATHS.capabilityMetadata))) {
      if (command !== 'types') return ''
      return memberHint(command, root, join(root, PROJECT_PATHS.backend), '后端')
    }
    if (hasPath(join(root, PROJECT_PATHS.packageManifest))) {
      if (command !== 'dev' && command !== 'preview') return ''
      const capabilities = readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && hasPath(join(root, entry.name, PROJECT_PATHS.capabilityMetadata)))
        .map(entry => join(root, entry.name))
        .sort()
      const script = command === 'dev' ? devScriptHint(root) : ''
      return `位置提示：这是行业 Capability 工作区根（${PROJECT_PATHS.packageManifest}）：${root}\n`
        + `${command} 请显式选择能力或插件目录，不自动选择工作区成员。\n${
          script
        }${capabilities.map(path => `  fh2-plugin ${command}${command === 'dev' ? ' cockpit' : ''} --root ${shellPath(path)}\n`).join('')}`
    }
    const container = basename(root)
    const capabilityRoot = dirname(root)
    if ((container === PROJECT_PATHS.frontend || container === PROJECT_PATHS.backend)
      && hasPath(join(capabilityRoot, PROJECT_PATHS.capabilityMetadata))) {
      return `位置提示：当前是 Capability 的 ${container} 成员父目录，不是插件根：${root}\n${
        command === 'dev' ? devScriptHint(dirname(capabilityRoot)) : ''
      }${command === 'types'
        ? memberHint(command, capabilityRoot, join(capabilityRoot, PROJECT_PATHS.backend), '后端')
        : memberHint(command, capabilityRoot, root, container === PROJECT_PATHS.frontend ? '前端' : '后端')}`
    }
    if (command === 'pack' && hasPath(join(root, 'plugins'))) return ''
    if (hasPath(join(root, 'public-distribution.json'))
      || (hasPath(join(root, 'packages/fh2-plugin-sdk')) && hasPath(join(root, 'packages/fh2-plugin-toolchain')))) {
      return `位置提示：这是插件开发工具根，不是插件工程：${root}\n`
        + '请进入 create 生成的工程，或用 --root 指向实际能力/插件目录。原始诊断保留如下。\n'
    }
    return `位置提示：目标目录没有 ${PROJECT_PATHS.packageManifest}、${PROJECT_PATHS.capabilityMetadata} 或 ${PROJECT_PATHS.sourceManifest}：${root}\n`
      + '请检查 --root 是否指向实际工程；自定义清单或配置请保留显式参数。原始诊断保留如下。\n'
  } catch {
    // 提示是尽力而为的只读操作；无权限、损坏 package.json 等不能覆盖原诊断。
    return ''
  }
}

export function isMissingPathError (error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function memberHint (command: string, capabilityRoot: string, containerRoot: string, side: string): string {
  const members = readdirSync(containerRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && hasPath(join(containerRoot, entry.name, PROJECT_PATHS.sourceManifest)))
    .map(entry => join(containerRoot, entry.name))
    .sort()
  return `能力目录：${capabilityRoot}\n${
    members.length === 0
      ? `请用 --root 指向含 ${PROJECT_PATHS.sourceManifest} 的${side}插件目录。\n`
      : `${side}成员（请自行选择）：\n${
        members.map(path => `  fh2-plugin ${command}${command === 'dev' ? ' cockpit' : ''} --root ${shellPath(path)}\n`).join('')}`}`
}

function devScriptHint (root: string): string {
  try {
    if (!hasPath(join(root, PROJECT_PATHS.packageManifest))) return ''
    const packagePath = join(root, 'package.json')
    if (!statSync(packagePath).isFile()) return ''
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (typeof pkg?.scripts?.['dev:cockpit'] !== 'string') return ''
    const manager = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined
    if (manager !== 'pnpm' && manager !== 'npm' && manager !== 'yarn') return ''
    return `已有工作区脚本：cd${process.platform === 'win32' ? ' /d' : ''} ${shellPath(root)} && ${manager} run dev:cockpit\n`
  } catch {
    return ''
  }
}

function shellPath (path: string): string {
  if (process.platform === 'win32') return `"${path}"`
  return `'${path.replaceAll('\'', '\'\\\'\'')}'`
}

function hasPath (path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}
