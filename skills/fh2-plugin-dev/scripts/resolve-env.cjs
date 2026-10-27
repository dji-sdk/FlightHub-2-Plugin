#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const { spawnSync } = require('node:child_process')

const SCHEMA_VERSION = 3
const TOOLCHAIN_PACKAGE = 'fh2-plugin-toolchain'
const CLI_NAME = 'fh2-plugin'
const MIN_NODE_MAJOR = 20
const MIN_NODE_MINOR = 19
const MIN_NODE_PATCH = 0
const WALK_LIMIT = 64
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn']
const PUBLIC_REGISTRY_HOST = 'registry.npmjs.org'

function parseVersion (version) {
  if (typeof version !== 'string') return null
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return null
  const numbers = match.slice(1, 4).map(value => Number(value ?? 0))
  if (numbers.some(value => !Number.isSafeInteger(value))) return null
  return {
    major: numbers[0] ?? 0,
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
  }
}

function isNodeCompatible (version) {
  const parsed = parseVersion(version)
  if (!parsed || version.includes('-')) return false
  if (parsed.major !== MIN_NODE_MAJOR) return parsed.major > MIN_NODE_MAJOR
  if (parsed.minor !== MIN_NODE_MINOR) return parsed.minor > MIN_NODE_MINOR
  return parsed.patch >= MIN_NODE_PATCH
}

function defaultExecFile (cmd, args, platform) {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: platform === 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return null
    return { stdout: String(result.stdout || '') }
  } catch {
    return null
  }
}

function normalizeDeps (overrides) {
  const platform = overrides.platform ?? process.platform
  return {
    platform,
    cwd: overrides.cwd ?? process.cwd(),
    platformRoot: overrides.platformRoot,
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? os.homedir(),
    nodeVersion: overrides.nodeVersion ?? process.version,
    pathEntryExists: overrides.pathEntryExists ?? ((candidate) => {
      try {
        return fs.existsSync(candidate)
      } catch {
        return false
      }
    }),
    packageEntryExists: overrides.packageEntryExists ?? ((candidate) => {
      try {
        // lstat preserves dangling installations and distinguishes absence from read failure.
        fs.lstatSync(candidate)
        return true
      } catch (error) {
        return error.code !== 'ENOENT' && error.code !== 'ENOTDIR'
      }
    }),
    readTextFile: overrides.readTextFile ?? ((candidate) => {
      try {
        return fs.readFileSync(candidate, 'utf8')
      } catch {
        return null
      }
    }),
    realpath: overrides.realpath ?? ((candidate) => {
      try {
        return fs.realpathSync(candidate)
      } catch {
        return null
      }
    }),
    execFile: overrides.execFile ?? ((cmd, args) => defaultExecFile(cmd, args, platform)),
  }
}

function readPackageInfo (packageDir, deps, pathImpl) {
  const packageJsonPath = pathImpl.join(packageDir, 'package.json')
  const text = deps.readTextFile(packageJsonPath)
  if (text === null) return deps.packageEntryExists(packageDir) ? { broken: true } : null
  try {
    const parsed = JSON.parse(text)
    const name = typeof parsed?.name === 'string' ? parsed.name : null
    if (name === null || typeof parsed.version !== 'string' || parsed.version.trim() === '') return { name, broken: true }
    return { name, version: parsed.version }
  } catch {
    return { broken: true }
  }
}

function walkUp (startDir, pathImpl) {
  const levels = []
  let current = startDir
  for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
    levels.push(current)
    const parent = pathImpl.dirname(current)
    if (parent === current) break
    current = parent
  }
  return levels
}

function scanLevelsForPackage (levels, packageName, deps, pathImpl) {
  const segments = packageName.split('/')
  for (const level of levels) {
    const packageDir = pathImpl.join(level, 'node_modules', ...segments)
    const info = readPackageInfo(packageDir, deps, pathImpl)
    if (info === null) continue
    if (info.broken || info.name !== packageName) return { dir: packageDir, info: null, broken: true }
    return { dir: packageDir, info, broken: null }
  }
  return null
}

function scanLevelsForSelfPackage (levels, packageName, deps, pathImpl) {
  for (const level of levels) {
    const info = readPackageInfo(level, deps, pathImpl)
    if (info?.broken && info.name === packageName) return { dir: level, info: null, broken: true }
    if (info && !info.broken && info.name === packageName) return { dir: level, info, broken: null }
  }
  return null
}

function getPathEntries (deps, pathImpl) {
  const pathEnv = deps.env.PATH ?? deps.env.Path ?? ''
  return pathEnv
    .split(pathImpl.delimiter)
    .map(entry => entry.trim())
    .map(entry => (entry.length >= 2 && ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith('\'') && entry.endsWith('\''))) ? entry.slice(1, -1) : entry))
    .filter(Boolean)
}

function getPathExtList (deps, platform) {
  if (platform !== 'win32') return ['']
  const pathExt = deps.env.PATHEXT ?? DEFAULT_PATHEXT
  return pathExt.split(';').map(entry => entry.trim()).filter(Boolean)
}

function findBinOnPath (name, deps, pathImpl, platform) {
  const extList = getPathExtList(deps, platform)
  for (const entry of getPathEntries(deps, pathImpl)) {
    for (const ext of extList) {
      const candidate = pathImpl.join(entry, name + ext)
      if (!deps.pathEntryExists(candidate)) continue
      return deps.realpath(candidate) || candidate
    }
  }
  return null
}

function createGlobalRootsResolver (deps) {
  let cached = null
  return () => {
    if (cached !== null) return cached
    const roots = []
    const seen = new Set()
    const specs = [
      ['npm', ['root', '-g']],
      ['pnpm', ['root', '-g']],
    ]
    for (const [cmd, args] of specs) {
      const result = deps.execFile(cmd, args)
      const firstLine = result && result.stdout ? result.stdout.trim().split(/\r?\n/)[0].trim() : ''
      if (!firstLine || seen.has(firstLine)) continue
      seen.add(firstLine)
      roots.push(firstLine)
    }
    cached = roots
    return roots
  }
}

function readGlobalRootPackage (root, packageName, deps, pathImpl) {
  const segments = packageName.split('/')
  const packageDir = pathImpl.join(root, ...segments)
  const info = readPackageInfo(packageDir, deps, pathImpl)
  if (info === null) return null
  return { dir: packageDir, info, broken: Boolean(info.broken || info.name !== packageName) }
}

function detectPackageIn (startDir, packageName, deps, pathImpl) {
  return scanLevelsForPackage(walkUp(startDir, pathImpl), packageName, deps, pathImpl)
}

function detectToolchain (projectDir, deps, pathImpl, platform, getGlobalRoots) {
  const fromLocal = detectPackageIn(projectDir, TOOLCHAIN_PACKAGE, deps, pathImpl)
  if (fromLocal) return withSource(fromLocal, 'local', deps)

  if (deps.platformRoot !== undefined) {
    const root = pathImpl.resolve(deps.cwd, deps.platformRoot)
    const dir = pathImpl.join(root, 'packages', 'fh2-plugin-toolchain')
    const rootInfo = readPackageInfo(root, deps, pathImpl)
    const info = readPackageInfo(dir, deps, pathImpl)
    const reason = !rootInfo || rootInfo.broken || rootInfo.name !== 'fh2-plugin-platform'
      ? 'platform_root_invalid'
      : !info || info.broken || info.name !== TOOLCHAIN_PACKAGE
          ? 'toolchain_package_json_invalid'
          : null
    // An explicit SOURCE is a selection, including when missing or damaged.
    return withSource({ dir, info, broken: reason !== null, reason }, 'linked', deps)
  }

  const binPath = findBinOnPath(CLI_NAME, deps, pathImpl, platform)
  if (binPath) {
    const binDir = pathImpl.dirname(binPath)
    if (pathImpl.basename(binPath) === 'fh2-plugin.mjs' && pathImpl.basename(binDir) === 'bin') {
      // The official bin identifies its package root even when metadata is unreadable.
      const dir = pathImpl.dirname(binDir)
      const info = readPackageInfo(dir, deps, pathImpl)
      return withSource({ dir, info, broken: Boolean(!info || info.broken || info.name !== TOOLCHAIN_PACKAGE) }, 'global', deps)
    }
    const binLevels = walkUp(binDir, pathImpl)
    const fromSelf = scanLevelsForSelfPackage(binLevels, TOOLCHAIN_PACKAGE, deps, pathImpl)
    const fromBin = fromSelf ?? scanLevelsForPackage(binLevels, TOOLCHAIN_PACKAGE, deps, pathImpl)
    if (fromBin) return withSource(fromBin, 'global', deps)
  }

  let brokenCandidate = null
  for (const root of getGlobalRoots()) {
    const found = readGlobalRootPackage(root, TOOLCHAIN_PACKAGE, deps, pathImpl)
    if (found === null) continue
    if (found.broken) {
      brokenCandidate = brokenCandidate ?? found
      continue
    }
    return withSource(found, 'global', deps)
  }

  return brokenCandidate === null ? null : withSource(brokenCandidate, 'global', deps)
}

function sourceOf (dir, fallback) {
  return dir.includes('node_modules') ? fallback : 'linked'
}

function withSource (found, source, deps) {
  const dir = deps.realpath(found.dir) || found.dir
  return { ...found, dir, source: sourceOf(dir, source) }
}

const LOCKFILE_MANAGERS = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

function detectPackageManager (deps, pathImpl, platform, projectDir) {
  for (const level of walkUp(projectDir, pathImpl)) {
    const isProjectLevel = level === projectDir
    const isWorkspaceRoot = deps.pathEntryExists(pathImpl.join(level, 'package.json'))
      || deps.pathEntryExists(pathImpl.join(level, 'pnpm-workspace.yaml'))
    if (!isProjectLevel && !isWorkspaceRoot) continue
    for (const [lockfile, name] of LOCKFILE_MANAGERS) {
      if (deps.pathEntryExists(pathImpl.join(level, lockfile))) {
        return { name, version: null, path: null, basis: 'lockfile' }
      }
    }
  }
  for (const name of PACKAGE_MANAGERS) {
    const binPath = findBinOnPath(name, deps, pathImpl, platform)
    if (!binPath) continue
    const result = deps.execFile(name, ['--version'])
    const version = result && result.stdout ? result.stdout.trim().split(/\r?\n/)[0].trim() : null
    return { name, version: version || null, path: binPath, basis: 'path' }
  }
  return { name: null, version: null, path: null, basis: null }
}

function classifyRegistryUrl (url) {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    return parsed.hostname === PUBLIC_REGISTRY_HOST ? 'public' : 'custom'
  } catch {
    return null
  }
}

function detectRegistry (projectDir, deps, pathImpl) {
  // 裸名包不走 scope registry；这里探测全局 registry 行与任意 scope 行（信息性），
  // 帮用户发现「把公共 registry 指到私有源」的环境问题。
  const pattern = /^\s*(@[0-9a-z-]+:registry|^registry)\s*=\s*(\S+)\s*$/gm
  const candidates = [
    [pathImpl.join(projectDir, '.npmrc'), 'project'],
    [pathImpl.join(deps.homedir, '.npmrc'), 'user'],
  ]
  for (const [file, source] of candidates) {
    const text = deps.readTextFile(file)
    if (!text) continue
    const values = new Map([...text.matchAll(pattern)].map(match => [match[1], match[2]]))
    const scoped = [...values.keys()].find(key => key !== 'registry')
    const value = values.get(scoped ?? 'registry')
    if (value === undefined) continue
    let url = null
    const kind = classifyRegistryUrl(value)
    if (kind !== null) {
      const parsed = new URL(value)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      url = parsed.href
    }
    return { scope: scoped === undefined ? null : scoped.slice(0, -':registry'.length), url, kind, source }
  }
  return { scope: null, url: null, kind: null, source: null }
}

function detectProject (projectDir, deps, pathImpl) {
  return {
    dir: projectDir,
    hasPackageJson: deps.readTextFile(pathImpl.join(projectDir, 'package.json')) !== null,
    hasFh2Manifest: deps.readTextFile(pathImpl.join(projectDir, 'fh2-plugin.json')) !== null,
    hasNodeModules: deps.pathEntryExists(pathImpl.join(projectDir, 'node_modules')),
  }
}

function buildActions (node, toolchain, contract) {
  const actions = []
  if (!node.compatible) {
    actions.push({ action: 'upgrade_node', required: true, detail: '司空 Toolchain 要求 Node >= 20.19。需求澄清照常可做，升级前先确认。' })
  }
  if (toolchain.path === null) {
    actions.push({ action: 'install_toolchain', required: true, detail: '缺 Toolchain。先问用户确认三件事：源码下载入口、固定 tag/commit、保存目录。然后在源码根按纯源码路线执行 pnpm install --frozen-lockfile，再执行 pnpm build:tooling，最后直接调用源码 bin 并用 --platform-root 复验。全局注册是独立可选动作。方案设计和后续流程要先完成初始化；用户拒绝时说明无法继续，不反复施压。' })
  } else if (toolchain.version === null) {
    actions.push({ action: 'repair_toolchain', required: true, detail: '所选源码根或 Toolchain 包缺失、损坏。先确认源码版本、根包身份和实际解析路径，再修这一份副本。不换到别的全局版本，也不顺手清理无关目录。' })
  } else if (contract.path === null) {
    actions.push({ action: 'repair_developer_runtime', required: true, detail: '所选 Toolchain 的 developer-runtime/manifest.json 缺失或读不出来。确认后从同一份源码版本恢复开发运行时数据并复验。探针只读取 manifest，不证明数据完整可用。' })
  }
  return actions
}

function describeContract (found, deps, pathImpl) {
  if (!found || found.broken) return { packagePath: found?.dir ?? null, path: null, version: null, source: null, reason: null }
  const contractRoot = pathImpl.join(found.dir, 'developer-runtime')
  const missing = { packagePath: found.dir, path: null, version: null, source: found.source }
  const text = deps.readTextFile(pathImpl.join(contractRoot, 'manifest.json'))
  if (text === null) return { ...missing, reason: 'developer_runtime_manifest_missing' }
  try {
    // This is a manifest-only probe, not the Toolchain's full projection loader.
    const manifest = JSON.parse(text)
    const version = manifest.sourceVersions?.contract
    if (manifest.kind !== 'fh2-developer-runtime' || manifest.formatVersion !== 1
      || typeof version !== 'string' || version.trim() === '') {
      return { ...missing, reason: 'developer_runtime_manifest_invalid' }
    }
    return { packagePath: found.dir, path: contractRoot, version, source: found.source, reason: null }
  } catch {
    return { ...missing, reason: 'developer_runtime_manifest_invalid' }
  }
}

function resolveEnvironment (overrides = {}) {
  const deps = normalizeDeps(overrides)
  const pathImpl = deps.platform === 'win32' ? path.win32 : path.posix
  const platform = deps.platform
  const getGlobalRoots = createGlobalRootsResolver(deps)

  const projectDir = pathImpl.resolve(deps.cwd)
  const project = detectProject(projectDir, deps, pathImpl)

  const node = {
    found: true,
    version: deps.nodeVersion,
    compatible: isNodeCompatible(deps.nodeVersion),
  }

  const packageManager = detectPackageManager(deps, pathImpl, platform, projectDir)
  const registry = detectRegistry(projectDir, deps, pathImpl)

  const toolchainFound = detectToolchain(projectDir, deps, pathImpl, platform, getGlobalRoots)
  const toolchain = toolchainFound && !toolchainFound.broken
    ? { path: toolchainFound.dir, version: toolchainFound.info.version, source: toolchainFound.source }
    : toolchainFound && toolchainFound.broken
      ? { path: toolchainFound.dir, version: null, source: null }
      : { path: null, version: null, source: null }
  const { reason: runtimeReason, ...contract } = describeContract(toolchainFound, deps, pathImpl)

  let execution
  if (!node.compatible) {
    execution = { status: 'node_upgrade_required', reason: 'node_below_minimum' }
  } else if (toolchainFound && !toolchainFound.broken && runtimeReason === null) {
    execution = { status: 'ready', reason: null }
  } else if (runtimeReason !== null) {
    execution = { status: 'broken_environment', reason: runtimeReason }
  } else if (toolchainFound && toolchainFound.broken) {
    execution = { status: 'broken_environment', reason: toolchainFound.reason ?? 'toolchain_package_json_invalid' }
  } else {
    execution = { status: 'bootstrap_required', reason: 'toolchain_not_found' }
  }

  const planning = {
    status: 'ready',
    source: contract.path === null ? 'bundled' : 'contract',
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    planning,
    execution,
    node,
    packageManager: { name: packageManager.name, version: packageManager.version, basis: packageManager.basis },
    toolchain,
    contract,
    registry,
    project,
    actions: buildActions(node, toolchain, contract),
  }
}

function main (argv) {
  const args = Array.isArray(argv) ? argv : process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('用法：node resolve-env.cjs [--project <目录>] [--platform-root <源码根>]\n按工程本地、显式源码根、PATH/全局的顺序只读探测 Toolchain 和包内开发运行时数据，输出 JSON。只检查 manifest 可读及来源版本，不验证完整数据。\n相对路径从调用工作目录解析；不访问网络，不安装依赖，不修改 npm 配置；缺失不阻断需求澄清。\n')
    return 0
  }
  const overrides = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index] === '--project' ? 'cwd' : args[index] === '--platform-root' ? 'platformRoot' : null
    if (!key || overrides[key] !== undefined) {
      process.stderr.write('错误：不支持的参数或重复参数，请使用 --help 查看用法。\n')
      return 2
    }
    const value = args[++index]
    if (!value || value.startsWith('--')) {
      process.stderr.write(`错误：${args[index - 1]} 需要一个目录参数。\n`)
      return 2
    }
    overrides[key] = path.resolve(value)
  }
  const state = resolveEnvironment(overrides)
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
  return 0
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = {
  SCHEMA_VERSION,
  TOOLCHAIN_PACKAGE,
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  MIN_NODE_PATCH,
  parseVersion,
  isNodeCompatible,
  classifyRegistryUrl,
  resolveEnvironment,
}
