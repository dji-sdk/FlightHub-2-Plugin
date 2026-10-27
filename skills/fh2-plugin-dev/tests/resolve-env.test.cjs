// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  resolveEnvironment,
  classifyRegistryUrl,
  isNodeCompatible,
  parseVersion,
  SCHEMA_VERSION,
} = require('../scripts/resolve-env.cjs')

const TOOLCHAIN_PACKAGE = 'fh2-plugin-toolchain'
const CONTRACT_PACKAGE = '@fixture-scope/local-contract-fixture'
const WINDOWS_NPM_ROOT = path.win32.join('C:\\', 'Users', 'test-user', 'AppData', 'Roaming', 'npm')

function pkgJson (name, version) {
  return JSON.stringify({ name, version })
}

function runtimeManifest (sourceVersion = '0.2.0-fixture') {
  return {
    kind: 'fh2-developer-runtime',
    formatVersion: 1,
    sourceVersions: {
      contract: sourceVersion,
      contractsVersion: '1.1.0',
      knowledgeStatus: 'reviewed',
      contractStatus: 'foundation-review-blocked',
      approvedEntries: 4,
      contractDigest: `sha256:${'a'.repeat(64)}`,
      bundleDigest: `sha256:${'b'.repeat(64)}`,
    },
    sourceBackendDigest: `sha256:${'c'.repeat(64)}`,
    publishedEntries: 1,
    files: [
      'backend.json',
      'knowledge.json',
      'resources.json',
      'schemas/backend-plugin-runtime.schema.json',
      'schemas/backend-plugin-source.schema.json',
      'schemas/workflow.schema.json',
    ].map(file => ({ path: file, sha256: `sha256:${'d'.repeat(64)}`, bytes: 1 })),
    projectionDigest: `sha256:${'e'.repeat(64)}`,
  }
}

function toolchainFiles (root, version = '0.1.0', sourceVersion = '0.2.0-fixture', pathImpl = path.posix) {
  return {
    [pathImpl.join(root, 'package.json')]: pkgJson(TOOLCHAIN_PACKAGE, version),
    [pathImpl.join(root, 'developer-runtime', 'manifest.json')]: JSON.stringify(runtimeManifest(sourceVersion)),
  }
}

function fakeDeps (overrides = {}) {
  const files = overrides.files ?? {}
  const bins = overrides.bins ?? []
  return {
    platform: overrides.platform ?? 'linux',
    cwd: overrides.cwd ?? '/proj',
    env: overrides.env ?? { PATH: overrides.pathEnv ?? '' },
    homedir: overrides.homedir ?? '/workspace/test-user',
    nodeVersion: overrides.nodeVersion ?? 'v20.19.0',
    pathEntryExists: candidate => bins.some(bin => bin.toLowerCase() === candidate.toLowerCase()),
    packageEntryExists: candidate => bins.includes(candidate) || Object.keys(files).some(file => file === candidate || file.startsWith(`${candidate}/`) || file.startsWith(`${candidate}\\`)),
    readTextFile: candidate => (Object.prototype.hasOwnProperty.call(files, candidate) ? files[candidate] : null),
    realpath: candidate => (overrides.realmap && overrides.realmap[candidate]) || candidate,
    execFile: overrides.execFile ?? (() => null),
  }
}

function diskFixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh2-skill-env-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cwd = path.join(root, 'project', 'member')
  fs.mkdirSync(cwd, { recursive: true })
  return { root, cwd, env: { PATH: '' }, homedir: root, nodeVersion: 'v20.19.0', execFile: () => null }
}

function writeFiles (files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
}

test('显式 SOURCE：未安装/未注册 CLI 仍可探测，且不执行全局查询', () => {
  const root = '/source 中文 path'
  const deps = fakeDeps({
    files: {
      [`${root}/package.json`]: pkgJson('fh2-plugin-platform', '0.1.0'),
      ...toolchainFiles(`${root}/packages/fh2-plugin-toolchain`),
    },
    execFile: () => {
      throw new Error('Explicit SOURCE must not query global packages')
    },
  })
  const state = resolveEnvironment({ ...deps, platformRoot: root })
  assert.equal(state.schemaVersion, 3)
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.path, `${root}/packages/fh2-plugin-toolchain`)
  assert.equal(state.toolchain.source, 'linked')
  assert.equal(state.contract.source, 'linked')
  assert.equal(state.actions.length, 0)
})

test('显式 SOURCE 的相对路径按调用 cwd 解析，Windows 同样支持', () => {
  for (const [platform, pathImpl, cwd, relative] of [
    ['linux', path.posix, '/work/project', '../source 中文'],
    ['win32', path.win32, 'C:\\work\\project', '..\\source 中文'],
  ]) {
    const root = pathImpl.resolve(cwd, relative)
    const deps = fakeDeps({ platform, cwd, files: {
      [pathImpl.join(root, 'package.json')]: pkgJson('fh2-plugin-platform', '0.1.0'),
      ...toolchainFiles(pathImpl.join(root, 'packages', 'fh2-plugin-toolchain'), '0.1.0', '0.2.0-fixture', pathImpl),
    } })
    const state = resolveEnvironment({ ...deps, platformRoot: relative })
    assert.equal(state.execution.status, 'ready', platform)
    assert.equal(state.toolchain.path, pathImpl.join(root, 'packages', 'fh2-plugin-toolchain'))
    assert.equal(state.toolchain.source, 'linked')
  }
})

test('局部优先于显式 SOURCE，损坏局部也不使用 SOURCE 兜底', () => {
  const source = '/source'
  const local = '/proj/node_modules/fh2-plugin-toolchain'
  for (const damaged of [false, true]) {
    const deps = fakeDeps({ files: {
      [`${source}/package.json`]: pkgJson('fh2-plugin-platform', '0.1.0'),
      ...toolchainFiles(`${source}/packages/fh2-plugin-toolchain`, '2.0.0'),
      ...toolchainFiles(local, '1.0.0'),
      ...(damaged ? { [`${local}/package.json`]: '{broken' } : {}),
    } })
    const state = resolveEnvironment({ ...deps, platformRoot: source })
    assert.equal(state.toolchain.path, local)
    assert.equal(state.toolchain.version, damaged ? null : '1.0.0')
    assert.equal(state.execution.status, damaged ? 'broken_environment' : 'ready')
  }
})

test('已选显式 SOURCE 缺失/损坏不回退有效 PATH 或全局安装', () => {
  const root = '/source'
  const toolchain = `${root}/packages/fh2-plugin-toolchain`
  const healthy = {
    [`${root}/package.json`]: pkgJson('fh2-plugin-platform', '0.1.0'),
    ...toolchainFiles(toolchain),
  }
  for (const [variant, overrides, reason] of [
    ['root-missing', { [`${root}/package.json`]: null }, 'platform_root_invalid'],
    ['root-invalid', { [`${root}/package.json`]: '{broken' }, 'platform_root_invalid'],
    ['root-name', { [`${root}/package.json`]: pkgJson('other', '0.1.0') }, 'platform_root_invalid'],
    ['toolchain-missing', { [`${toolchain}/package.json`]: null }, 'toolchain_package_json_invalid'],
    ['toolchain-name', { [`${toolchain}/package.json`]: pkgJson('other', '0.1.0') }, 'toolchain_package_json_invalid'],
    ['runtime-missing', { [`${toolchain}/developer-runtime/manifest.json`]: null }, 'developer_runtime_manifest_missing'],
    ['runtime-invalid', { [`${toolchain}/developer-runtime/manifest.json`]: '{broken' }, 'developer_runtime_manifest_invalid'],
  ]) {
    const deps = fakeDeps({
      files: { ...healthy, ...overrides, ...toolchainFiles('/global/packages/fh2-plugin-toolchain', '2.0.0') },
      pathEnv: '/bin',
      bins: ['/bin/fh2-plugin'],
      realmap: { '/bin/fh2-plugin': '/global/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs' },
      execFile: () => {
        throw new Error('Selected SOURCE must not query globals')
      },
    })
    const state = resolveEnvironment({ ...deps, platformRoot: root })
    assert.equal(state.execution.status, 'broken_environment', variant)
    assert.equal(state.execution.reason, reason, variant)
    assert.equal(state.toolchain.path, toolchain, variant)
    assert.equal(state.actions[0].action, reason.startsWith('developer_runtime') ? 'repair_developer_runtime' : 'repair_toolchain')
  }
  const absent = resolveEnvironment({ ...fakeDeps({}), platformRoot: '/absent' })
  assert.equal(absent.execution.reason, 'platform_root_invalid')
  assert.equal(absent.toolchain.path, '/absent/packages/fh2-plugin-toolchain')
})

test('真实 CLI：SOURCE 相对调用 cwd，而不是 --project，支持两个参数任意顺序', (t) => {
  const fixture = diskFixture(t)
  const root = path.join(fixture.root, 'source 中文 path')
  writeFiles({
    [path.join(root, 'package.json')]: pkgJson('fh2-plugin-platform', '0.1.0'),
    ...toolchainFiles(path.join(root, 'packages', 'fh2-plugin-toolchain'), '0.1.0', '0.2.0-fixture', path),
  })
  const script = path.join(__dirname, '..', 'scripts', 'resolve-env.cjs')
  for (const args of [
    ['--project', fixture.cwd, '--platform-root', 'source 中文 path'],
    ['--platform-root', 'source 中文 path', '--project', fixture.cwd],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: fixture.root, env: { PATH: '' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
    const state = JSON.parse(result.stdout)
    assert.equal(state.project.dir, fixture.cwd)
    const realToolchain = fs.realpathSync(path.join(root, 'packages', 'fh2-plugin-toolchain'))
    assert.equal(state.toolchain.path, realToolchain)
    assert.equal(state.contract.path, path.join(realToolchain, 'developer-runtime'))
    assert.equal(state.toolchain.source, 'linked')
  }
})

test('parseVersion 与 isNodeCompatible 边界', () => {
  assert.deepEqual(parseVersion('v20.19.0'), { major: 20, minor: 19, patch: 0 })
  assert.deepEqual(parseVersion('20.19'), { major: 20, minor: 19, patch: 0 })
  assert.equal(parseVersion('abc'), null)
  assert.equal(parseVersion(null), null)
  assert.equal(isNodeCompatible('v20.19.0'), true)
  assert.equal(isNodeCompatible('v20.19.5'), true)
  assert.equal(isNodeCompatible('v20.20.0'), true)
  assert.equal(isNodeCompatible('v22.0.0'), true)
  assert.equal(isNodeCompatible('v24.0.0'), true)
  assert.equal(isNodeCompatible('v20.18.9'), false)
  assert.equal(isNodeCompatible('20.19'), true)
  assert.equal(isNodeCompatible('20.18'), false)
  assert.equal(isNodeCompatible('v20.18.0'), false)
  assert.equal(isNodeCompatible('v19.9.0'), false)
  assert.equal(isNodeCompatible('v18.0.0'), false)
  assert.equal(isNodeCompatible('v20.19.0-beta.1'), false)
  assert.equal(isNodeCompatible(''), false)
  assert.equal(isNodeCompatible('20.19.0.3'), false)
  assert.equal(isNodeCompatible('22.-1.2'), false)
})

test('POSIX 局部 Toolchain：直接就绪', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain'),
    },
  }))
  assert.equal(state.schemaVersion, SCHEMA_VERSION)
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'local')
  assert.equal(state.toolchain.version, '0.1.0')
  assert.equal(state.planning.status, 'ready')
  assert.equal(state.planning.source, 'contract')
  assert.equal(state.contract.path, '/proj/node_modules/fh2-plugin-toolchain/developer-runtime')
  assert.equal(state.contract.packagePath, state.toolchain.path)
  assert.equal(state.contract.version, '0.2.0-fixture')
})

test('局部优先：局部 Toolchain 胜出 PATH 与全局', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain', '9.9.9', '9.0.0-local'),
      ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
    },
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': '/usr/lib/node_modules/fh2-plugin-toolchain/bin/fh2-plugin.mjs' },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'local')
  assert.equal(state.toolchain.version, '9.9.9')
  assert.equal(state.contract.source, 'local')
  assert.equal(state.contract.version, '9.0.0-local')
})

test('PATH bin 向上回溯到 npm 全局布局（POSIX 软链 realpath）', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
    },
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': '/usr/lib/node_modules/fh2-plugin-toolchain/bin/fh2-plugin.mjs' },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'global')
  assert.equal(state.toolchain.path, '/usr/lib/node_modules/fh2-plugin-toolchain')
})

test('Windows 模拟：Path 键 + PATHEXT + .cmd 垫片（非软链）', () => {
  const state = resolveEnvironment(fakeDeps({
    platform: 'win32',
    cwd: 'C:\\proj',
    env: {
      Path: `${WINDOWS_NPM_ROOT};C:\\Windows\\System32`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    files: {
      ...toolchainFiles(path.win32.join(WINDOWS_NPM_ROOT, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/')), '0.1.0', '0.2.0-fixture', path.win32),
    },
    bins: [path.win32.join(WINDOWS_NPM_ROOT, 'fh2-plugin.cmd')],
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'global')
  assert.equal(state.toolchain.path, path.win32.join(WINDOWS_NPM_ROOT, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/')))
  assert.equal(state.toolchain.version, '0.1.0')
})

test('pnpm 全局 root 兜底命中', () => {
  const state = resolveEnvironment(fakeDeps({
    execFile: (cmd, args) => {
      if (cmd === 'pnpm' && args[0] === 'root') return { stdout: '/workspace/test-user/.local/share/pnpm/global/5/node_modules\n' }
      return null
    },
    files: {
      ...toolchainFiles('/workspace/test-user/.local/share/pnpm/global/5/node_modules/fh2-plugin-toolchain'),
    },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'global')
  assert.equal(state.toolchain.path, '/workspace/test-user/.local/share/pnpm/global/5/node_modules/fh2-plugin-toolchain')
})

test('npm linked 源码 checkout：识别为 linked 来源', () => {
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': '/repo/packages/fh2-plugin-toolchain/bin/fh2-plugin.mjs' },
    files: {
      ...toolchainFiles('/repo/packages/fh2-plugin-toolchain'),
    },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'linked')
  assert.equal(state.toolchain.path, '/repo/packages/fh2-plugin-toolchain')
  assert.equal(state.contract.source, 'linked')
  assert.equal(state.contract.path, '/repo/packages/fh2-plugin-toolchain/developer-runtime')
})

test('Toolchain 完全缺失：bootstrap_required 且产出待确认动作', () => {
  const state = resolveEnvironment(fakeDeps({}))
  assert.equal(state.execution.status, 'bootstrap_required')
  assert.equal(state.execution.reason, 'toolchain_not_found')
  assert.equal(state.planning.status, 'ready')
  const actions = state.actions.map(item => item.action)
  assert.ok(actions.includes('install_toolchain'))
  assert.ok(!actions.includes('configure_registry'))
  assert.ok(!actions.includes('install_contract'))
  const installAction = state.actions.find(item => item.action === 'install_toolchain')
  assert.equal(installAction.required, true)
  assert.match(installAction.detail, /下载入口.*tag\/commit.*保存目录/)
  assert.ok(installAction.detail.indexOf('pnpm install --frozen-lockfile') < installAction.detail.indexOf('pnpm build:tooling'))
  assert.ok(!installAction.detail.includes('check-prebuilt.mjs'))
  assert.ok(!installAction.detail.includes('prebuilt'))
  assert.ok(!installAction.detail.includes('pnpm link:toolchain'))
  assert.ok(!installAction.detail.includes('local-contract-fixture'))
})

test('Node 过低：规划仍就绪，执行要求升级', () => {
  const state = resolveEnvironment(fakeDeps({ nodeVersion: 'v18.0.0' }))
  assert.equal(state.node.compatible, false)
  assert.equal(state.execution.status, 'node_upgrade_required')
  assert.equal(state.planning.status, 'ready')
  assert.ok(state.actions.some(item => item.action === 'upgrade_node'))
})

test('Node 过低但 Toolchain 已装：保留探测到的 Toolchain 信息', () => {
  const state = resolveEnvironment(fakeDeps({
    nodeVersion: 'v18.0.0',
    files: {
      ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain'),
    },
  }))
  assert.equal(state.execution.status, 'node_upgrade_required')
  assert.equal(state.toolchain.path, '/proj/node_modules/fh2-plugin-toolchain')
  assert.equal(state.toolchain.version, '0.1.0')
  assert.equal(state.toolchain.source, 'local')
  assert.equal(state.contract.version, '0.2.0-fixture')
  assert.equal(state.execution.reason, 'node_below_minimum')
})

test('开发运行时数据仅随所选 Toolchain 读取，不选局部完整 Contract 的版本', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain'),
      '/proj/node_modules/@fixture-scope/local-contract-fixture/package.json': pkgJson(CONTRACT_PACKAGE, '0.1.0-beta.2'),
      '/proj/node_modules/@fixture-scope/local-contract-fixture/platform-contract/index.json': '{}',
    },
  }))
  assert.equal(state.contract.source, 'local')
  assert.equal(state.contract.version, '0.2.0-fixture')
  assert.equal(state.planning.source, 'contract')
  assert.equal(state.schemaVersion, 3)
  assert.equal(state.contract.packagePath, state.toolchain.path)
  assert.equal(state.contract.path, '/proj/node_modules/fh2-plugin-toolchain/developer-runtime')
  assert.ok(!state.actions.some(item => item.action.startsWith('install_')))
})

test('file: Toolchain 自带 manifest，不读取嵌套完整 Contract', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain'),
      '/proj/node_modules/fh2-plugin-toolchain/node_modules/@fixture-scope/local-contract-fixture/package.json': pkgJson(CONTRACT_PACKAGE, '0.1.0-beta.2'),
      '/proj/node_modules/fh2-plugin-toolchain/node_modules/@fixture-scope/local-contract-fixture/platform-contract/index.json': '{}',
    },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.contract.source, 'local')
  assert.equal(state.contract.path, '/proj/node_modules/fh2-plugin-toolchain/developer-runtime')
})

test('npm hoisted 完整 Contract 不作为缺失 manifest 的备用来源', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/node_modules/fh2-plugin-toolchain/package.json': pkgJson(TOOLCHAIN_PACKAGE, '0.1.0'),
      '/proj/node_modules/@fixture-scope/local-contract-fixture/package.json': pkgJson(CONTRACT_PACKAGE, '0.1.0-beta.1'),
      '/proj/node_modules/@fixture-scope/local-contract-fixture/platform-contract/index.json': '{}',
    },
    pathEnv: '/usr/local/bin',
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'developer_runtime_manifest_missing')
  assert.equal(state.contract.source, 'local')
  assert.equal(state.contract.path, null)
})

test('pnpm store：运行时数据根和版本来自 Toolchain realpath，不来自同级 Contract', () => {
  const storeToolchain = '/store/.pnpm/fh2-plugin-toolchain@1.0.0/node_modules/fh2-plugin-toolchain'
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/node_modules/fh2-plugin-toolchain/package.json': pkgJson(TOOLCHAIN_PACKAGE, '1.0.0'),
      ...toolchainFiles(storeToolchain, '1.0.0', '0.3.0-store'),
      '/store/.pnpm/fh2-plugin-toolchain@1.0.0/node_modules/@fixture-scope/local-contract-fixture/package.json': pkgJson(CONTRACT_PACKAGE, '0.1.0-beta.2'),
      '/store/.pnpm/fh2-plugin-toolchain@1.0.0/node_modules/@fixture-scope/local-contract-fixture/platform-contract/index.json': '{}',
    },
    realmap: { '/proj/node_modules/fh2-plugin-toolchain': storeToolchain },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.path, storeToolchain)
  assert.equal(state.contract.packagePath, storeToolchain)
  assert.equal(state.contract.source, 'local')
  assert.equal(state.contract.path, `${storeToolchain}/developer-runtime`)
  assert.equal(state.contract.version, '0.3.0-store')
})

test('Toolchain manifest 缺失：要求修复所选开发运行时数据，不建议安装 Contract', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/node_modules/fh2-plugin-toolchain/package.json': pkgJson(TOOLCHAIN_PACKAGE, '0.1.0'),
    },
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'developer_runtime_manifest_missing')
  assert.deepEqual(state.contract, { packagePath: state.toolchain.path, path: null, version: null, source: 'local' })
  assert.equal(state.planning.source, 'bundled')
  const runtimeAction = state.actions.find(item => item.action === 'repair_developer_runtime')
  assert.equal(runtimeAction.required, true)
  assert.ok(!state.actions.some(item => item.action === 'install_contract'))
})

test('开发运行时数据有逻辑 index 资源而无磁盘 index.json，探针只读 manifest', () => {
  const root = '/proj/node_modules/fh2-plugin-toolchain'
  const files = {
    ...toolchainFiles(root),
    [`${root}/developer-runtime/resources.json`]: JSON.stringify({
      facts: {},
      files: { 'index.json': { schemaVersion: 1, documents: { knowledge: { index: 'knowledge/index.json' } } } },
    }),
  }
  const deps = fakeDeps({ files })
  const reads = []
  const state = resolveEnvironment({
    ...deps,
    readTextFile: (candidate) => {
      reads.push(candidate)
      assert.ok(!candidate.includes('/local-contract-fixture/'))
      return deps.readTextFile(candidate)
    },
  })
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.contract.path, `${root}/developer-runtime`)
  assert.deepEqual(reads.filter(candidate => candidate.includes('/developer-runtime/')), [`${root}/developer-runtime/manifest.json`])
  assert.ok(!Object.prototype.hasOwnProperty.call(files, `${root}/developer-runtime/index.json`))
})

test('manifest 最小探测不验证 inventory/hash/知识，不宣称完整运行时数据已加载', () => {
  const root = '/proj/node_modules/fh2-plugin-toolchain'
  const state = resolveEnvironment(fakeDeps({
    files: {
      [`${root}/package.json`]: pkgJson(TOOLCHAIN_PACKAGE, '0.1.0'),
      [`${root}/developer-runtime/manifest.json`]: JSON.stringify({
        kind: 'fh2-developer-runtime',
        formatVersion: 1,
        sourceVersions: { contract: '0.2.0-manifest-only' },
      }),
    },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.contract.version, '0.2.0-manifest-only')
  assert.ok(!('validated' in state.contract))
  assert.ok(!('loaded' in state.contract))
})

test('损坏/错误格式/缺来源版本的 manifest 阻断，但需求澄清仍 ready', () => {
  const root = '/proj/node_modules/fh2-plugin-toolchain'
  for (const manifest of [
    '',
    'not-json{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...runtimeManifest(), kind: 'fh2-private-contract' }),
    JSON.stringify({ ...runtimeManifest(), formatVersion: 2 }),
    JSON.stringify({ ...runtimeManifest(), sourceVersions: null }),
    JSON.stringify({ ...runtimeManifest(), sourceVersions: {} }),
    JSON.stringify({ ...runtimeManifest(), sourceVersions: { contract: 2 } }),
    JSON.stringify({ ...runtimeManifest(), sourceVersions: { contract: ' ' } }),
  ]) {
    const state = resolveEnvironment(fakeDeps({
      files: { ...toolchainFiles(root), [`${root}/developer-runtime/manifest.json`]: manifest },
    }))
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'developer_runtime_manifest_invalid')
    assert.equal(state.planning.status, 'ready')
    assert.equal(state.contract.packagePath, root)
    assert.equal(state.contract.path, null)
    assert.equal(state.contract.version, null)
    assert.ok(state.actions.some(item => item.action === 'repair_developer_runtime'))
    assert.ok(!state.actions.some(item => item.action === 'install_contract'))
  }
})

test('局部 manifest 损坏时不从全局正确副本或相邻目录回退', () => {
  const local = '/proj/node_modules/fh2-plugin-toolchain'
  const global = '/usr/lib/node_modules/fh2-plugin-toolchain'
  const state = resolveEnvironment(fakeDeps({
    files: {
      ...toolchainFiles(local),
      [`${local}/developer-runtime/manifest.json`]: '{broken',
      ...toolchainFiles(global, '2.0.0', '2.0.0-global'),
      '/proj/developer-runtime/manifest.json': JSON.stringify(runtimeManifest('3.0.0-adjacent')),
    },
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': `${global}/bin/fh2-plugin.mjs` },
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.toolchain.path, local)
  assert.equal(state.contract.packagePath, local)
  assert.equal(state.contract.path, null)
})

test('局部 file: 软链指向源码：Toolchain 和运行时数据都报告真实源码路径', () => {
  const local = '/proj/node_modules/fh2-plugin-toolchain'
  const source = '/repo/packages/fh2-plugin-toolchain'
  const state = resolveEnvironment(fakeDeps({
    files: { [`${local}/package.json`]: pkgJson(TOOLCHAIN_PACKAGE, '0.1.0'), ...toolchainFiles(source) },
    realmap: { [local]: source },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'linked')
  assert.equal(state.toolchain.path, source)
  assert.equal(state.contract.packagePath, source)
  assert.equal(state.contract.path, `${source}/developer-runtime`)
  assert.equal(state.contract.source, 'linked')
})

test('Toolchain 缺失：SOURCE 初始化不建议独立知识或 Contract 安装', () => {
  const state = resolveEnvironment(fakeDeps({}))
  const actions = state.actions.map(item => item.action)
  assert.ok(actions.includes('install_toolchain'))
  assert.ok(!actions.includes('install_knowledge'))
  assert.ok(!actions.includes('install_contract'))
  assert.ok(state.actions.find(item => item.action === 'install_toolchain').detail.includes('--platform-root'))
})

test('Toolchain package.json 损坏：broken_environment 而非误报就绪', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/node_modules/fh2-plugin-toolchain/package.json': 'not-json{{{',
    },
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
  assert.equal(state.toolchain.path, '/proj/node_modules/fh2-plugin-toolchain')
  assert.equal(state.toolchain.version, null)
  assert.equal(state.contract.packagePath, state.toolchain.path)
  assert.ok(!state.actions.some(item => item.action === 'install_toolchain'))
  assert.ok(state.actions.some(item => item.action === 'repair_toolchain'))
})

test('局部损坏包不被正确祖先或全局包掩盖，缺版本/错误身份同样阻断', () => {
  for (const packageJson of ['{broken', 'null', '{}', pkgJson('other-tool', '1.0.0'), JSON.stringify({ name: TOOLCHAIN_PACKAGE })]) {
    const state = resolveEnvironment(fakeDeps({
      cwd: '/proj/member',
      files: {
        '/proj/member/node_modules/fh2-plugin-toolchain/package.json': packageJson,
        ...toolchainFiles('/proj/node_modules/fh2-plugin-toolchain'),
        ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
      },
      execFile: (cmd, args) => cmd === 'npm' && args[0] === 'root' ? { stdout: '/usr/lib/node_modules\n' } : null,
    }))
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
    assert.equal(state.toolchain.path, '/proj/member/node_modules/fh2-plugin-toolchain')
  }
})

for (const entry of ['directory', 'symlink', 'dangling-symlink']) {
  test(`real fs: local ${entry} without metadata blocks ancestor and global fallback`, (t) => {
    const fixture = diskFixture(t)
    const local = path.join(fixture.cwd, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
    const ancestor = path.join(path.dirname(fixture.cwd), 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
    const globalRoot = path.join(fixture.root, 'global', 'node_modules')
    writeFiles({
      ...toolchainFiles(ancestor, '2.0.0', '2.0.0-ancestor'),
      ...toolchainFiles(path.join(globalRoot, ...TOOLCHAIN_PACKAGE.split('/')), '3.0.0', '3.0.0-global'),
    })
    if (entry === 'directory') {
      fs.mkdirSync(local, { recursive: true })
    } else {
      const target = path.join(fixture.root, 'source', 'custom-toolchain')
      if (entry === 'symlink') fs.mkdirSync(target, { recursive: true })
      fs.mkdirSync(path.dirname(local), { recursive: true })
      // Windows 目录链接用 junction（无需开发者模式；目标须为绝对路径）
      fs.symlinkSync(process.platform === 'win32' ? path.resolve(target) : target, local, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const calls = []
    const state = resolveEnvironment({
      ...fixture,
      execFile: (cmd, args) => {
        calls.push([cmd, args])
        return { stdout: `${globalRoot}\n` }
      },
    })
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
    const selected = entry === 'dangling-symlink' ? local : fs.realpathSync(local)
    assert.deepEqual(state.toolchain, { path: selected, version: null, source: null })
    assert.deepEqual(state.contract, { packagePath: selected, path: null, version: null, source: null })
    assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
    assert.equal(state.actions[0].required, true)
    assert.equal(state.schemaVersion, 3)
    assert.deepEqual(calls, [])
  })
}

for (const code of ['EACCES', 'EIO']) {
  test(`injected ${code}: unreadable local metadata blocks ancestor fallback`, (t) => {
    const fixture = diskFixture(t)
    const local = path.join(fixture.cwd, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
    const ancestor = path.join(path.dirname(fixture.cwd), 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
    writeFiles({ ...toolchainFiles(local), ...toolchainFiles(ancestor, '2.0.0') })
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (candidate, ...args) => {
      if (candidate === path.join(local, 'package.json')) throw Object.assign(new Error('fixture read failure'), { code })
      return read(candidate, ...args)
    })
    const state = resolveEnvironment(fixture)
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
    assert.equal(state.toolchain.path, fs.realpathSync(local))
    assert.equal(state.contract.packagePath, state.toolchain.path)
    assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
  })
}

test('injected EACCES: unreadable local package entry is not treated as absent', (t) => {
  const fixture = diskFixture(t)
  const local = path.join(fixture.cwd, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
  const ancestor = path.join(path.dirname(fixture.cwd), 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
  fs.mkdirSync(local, { recursive: true })
  writeFiles(toolchainFiles(ancestor))
  const lstat = fs.lstatSync
  t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
    if (candidate === local) throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' })
    return lstat(candidate, ...args)
  })
  const state = resolveEnvironment(fixture)
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.toolchain.path, fs.realpathSync(local))
  assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
})

test('real fs: genuinely absent local installation still uses valid ancestor', (t) => {
  const fixture = diskFixture(t)
  const ancestor = path.join(path.dirname(fixture.cwd), 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
  writeFiles(toolchainFiles(ancestor))
  const state = resolveEnvironment(fixture)
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.path, fs.realpathSync(ancestor))
  assert.equal(state.toolchain.source, 'local')
})

for (const target of ['source/custom-toolchain', 'store/.pnpm/toolchain/node_modules/fh2-plugin-toolchain']) {
  test(`real fs: local link resolves package and manifest from ${target}`, (t) => {
    const fixture = diskFixture(t)
    const local = path.join(fixture.cwd, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/'))
    const source = path.join(fixture.root, target)
    writeFiles(toolchainFiles(source))
    fs.mkdirSync(path.dirname(local), { recursive: true })
    // junction 需要绝对目标；POSIX 保持相对链接场景
    fs.symlinkSync(process.platform === 'win32' ? source : path.relative(path.dirname(local), source), local, process.platform === 'win32' ? 'junction' : 'dir')
    const state = resolveEnvironment(fixture)
    assert.equal(state.execution.status, 'ready')
    assert.equal(state.toolchain.path, fs.realpathSync(source))
    assert.equal(state.toolchain.source, target.startsWith('store/') ? 'local' : 'linked')
    assert.equal(state.contract.packagePath, state.toolchain.path)
    assert.equal(state.contract.path, path.join(state.toolchain.path, 'developer-runtime'))
  })
}

test('全局 root 中的 Toolchain 损坏：同样报 broken_environment', () => {
  const state = resolveEnvironment(fakeDeps({
    execFile: (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'root') return { stdout: '/usr/lib/node_modules\n' }
      return null
    },
    files: {
      '/usr/lib/node_modules/fh2-plugin-toolchain/package.json': 'broken',
    },
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
  assert.equal(state.toolchain.path, '/usr/lib/node_modules/fh2-plugin-toolchain')
})

for (const metadata of ['missing', 'invalid']) {
  test(`real fs: unbound PNPM_HOME shim skips npm root with ${metadata} metadata for valid pnpm root`, (t) => {
    const fixture = diskFixture(t)
    const pnpmHome = path.join(fixture.root, 'pnpm-home')
    const shim = path.join(pnpmHome, 'fh2-plugin')
    const npmRoot = path.join(fixture.root, 'npm-prefix', 'lib', 'node_modules')
    const npmPackage = path.join(npmRoot, ...TOOLCHAIN_PACKAGE.split('/'))
    const pnpmRoot = path.join(pnpmHome, 'global', '5', 'node_modules')
    const pnpmPackage = path.join(pnpmRoot, ...TOOLCHAIN_PACKAGE.split('/'))
    writeFiles({
      [shim]: '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/global/5/node_modules/fh2-plugin-toolchain/bin/fh2-plugin.mjs" "$@"\n',
      ...toolchainFiles(pnpmPackage, '2.0.0', '2.0.0-pnpm'),
    })
    fs.mkdirSync(npmPackage, { recursive: true })
    if (metadata === 'invalid') fs.writeFileSync(path.join(npmPackage, 'package.json'), '{stale-broken')
    assert.equal(fs.lstatSync(shim).isSymbolicLink(), false)
    const calls = []
    const state = resolveEnvironment({
      ...fixture,
      env: { PATH: pnpmHome, PNPM_HOME: pnpmHome },
      execFile: (cmd, args) => {
        calls.push([cmd, args])
        return { stdout: `${cmd === 'npm' ? npmRoot : pnpmRoot}\n` }
      },
    })
    assert.equal(state.execution.status, 'ready')
    assert.deepEqual(state.toolchain, { path: fs.realpathSync(pnpmPackage), version: '2.0.0', source: 'global' })
    assert.equal(state.contract.packagePath, state.toolchain.path)
    assert.equal(state.contract.version, '2.0.0-pnpm')
    assert.deepEqual(state.actions, [])
    assert.deepEqual(calls, [['npm', ['root', '-g']], ['pnpm', ['root', '-g']]])
  })
}

test('unbound global-root discovery reports first broken candidate if no valid package exists', () => {
  const npmRoot = '/npm-prefix/lib/node_modules'
  const pnpmRoot = '/pnpm-home/global/5/node_modules'
  const npmPackage = `${npmRoot}/${TOOLCHAIN_PACKAGE}`
  for (const pnpmFiles of [{}, { [`${pnpmRoot}/${TOOLCHAIN_PACKAGE}/package.json`]: '{also-broken' }]) {
    const state = resolveEnvironment(fakeDeps({
      pathEnv: '/pnpm-home',
      bins: ['/pnpm-home/fh2-plugin'],
      files: { [`${npmPackage}/package.json`]: '{stale-broken', ...pnpmFiles },
      execFile: cmd => ({ stdout: `${cmd === 'npm' ? npmRoot : pnpmRoot}\n` }),
    }))
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
    assert.equal(state.toolchain.path, npmPackage)
    assert.equal(state.contract.packagePath, npmPackage)
    assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
  }
})

test('global-root discovery does not replace a selected package with missing runtime manifest', () => {
  const npmRoot = '/npm-prefix/lib/node_modules'
  const pnpmRoot = '/pnpm-home/global/5/node_modules'
  const npmPackage = `${npmRoot}/${TOOLCHAIN_PACKAGE}`
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/pnpm-home',
    bins: ['/pnpm-home/fh2-plugin'],
    files: {
      [`${npmPackage}/package.json`]: pkgJson(TOOLCHAIN_PACKAGE, '1.0.0'),
      ...toolchainFiles(`${pnpmRoot}/${TOOLCHAIN_PACKAGE}`, '2.0.0'),
    },
    execFile: cmd => ({ stdout: `${cmd === 'npm' ? npmRoot : pnpmRoot}\n` }),
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'developer_runtime_manifest_missing')
  assert.equal(state.toolchain.path, npmPackage)
  assert.deepEqual(state.actions.map(item => item.action), ['repair_developer_runtime'])
})

test('PATH 实际源码 bin 的包损坏时，不用另一全局安装掩盖', () => {
  const source = '/repo/packages/fh2-plugin-toolchain'
  const state = resolveEnvironment(fakeDeps({
    files: {
      [`${source}/package.json`]: '{broken',
      ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
    },
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': `${source}/bin/fh2-plugin.mjs` },
    execFile: (cmd, args) => cmd === 'npm' && args[0] === 'root' ? { stdout: '/usr/lib/node_modules\n' } : null,
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
  assert.equal(state.toolchain.path, source)
  assert.equal(state.contract.packagePath, source)
})

for (const metadata of ['missing', 'unreadable']) {
  test(`real fs: PATH official bin with ${metadata} metadata blocks global fallback`, (t) => {
    if (process.platform === 'win32') {
      // Windows 文件 symlink 需要开发者模式/管理员；本场景由 POSIX CI 覆盖，
      // Windows 的 PATH 解析逻辑由下方 mock 模拟用例覆盖。
      t.skip('Windows 文件 symlink 需要开发者模式')
      return
    }
    const fixture = diskFixture(t)
    const source = path.join(fixture.root, 'custom-checkout', 'tooling')
    const packageJson = path.join(source, 'package.json')
    const files = toolchainFiles(source)
    if (metadata === 'missing') delete files[packageJson]
    const bin = path.join(source, 'bin', 'fh2-plugin.mjs')
    const pathDir = path.join(fixture.root, 'path-bin')
    const globalRoot = path.join(fixture.root, 'global', 'node_modules')
    writeFiles({
      ...files,
      [bin]: '#!/usr/bin/env node\n',
      ...toolchainFiles(path.join(globalRoot, ...TOOLCHAIN_PACKAGE.split('/'))),
    })
    fs.mkdirSync(pathDir)
    fs.symlinkSync(bin, path.join(pathDir, 'fh2-plugin'))
    if (metadata === 'unreadable') {
      const read = fs.readFileSync
      t.mock.method(fs, 'readFileSync', (candidate, ...args) => {
        if (candidate === fs.realpathSync(packageJson)) throw Object.assign(new Error('fixture permission failure'), { code: 'EACCES' })
        return read(candidate, ...args)
      })
    }
    const calls = []
    const state = resolveEnvironment({
      ...fixture,
      env: { PATH: pathDir },
      execFile: (cmd, args) => {
        calls.push([cmd, args])
        return { stdout: `${globalRoot}\n` }
      },
    })
    assert.equal(state.execution.status, 'broken_environment')
    assert.equal(state.execution.reason, 'toolchain_package_json_invalid')
    assert.equal(state.toolchain.path, fs.realpathSync(source))
    assert.equal(state.contract.packagePath, state.toolchain.path)
    assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
    assert.deepEqual(calls, [])
  })
}

test('real fs: unrelated malformed bin ancestor does not mask valid Toolchain', (t) => {
  if (process.platform === 'win32') {
    // Windows 文件 symlink 需要开发者模式/管理员；本场景由 POSIX CI 覆盖
    t.skip('Windows 文件 symlink 需要开发者模式')
    return
  }
  const fixture = diskFixture(t)
  const source = path.join(fixture.root, 'checkout', 'tooling')
  const pathDir = path.join(fixture.root, 'path-bin')
  const bin = path.join(source, 'bin', 'fh2-plugin.mjs')
  writeFiles({
    ...toolchainFiles(source),
    [bin]: '#!/usr/bin/env node\n',
    [path.join(source, 'bin', 'package.json')]: '{unrelated-broken',
    [path.join(fixture.root, 'package.json')]: '{unrelated-broken',
  })
  fs.mkdirSync(pathDir)
  fs.symlinkSync(bin, path.join(pathDir, 'fh2-plugin'))
  const state = resolveEnvironment({ ...fixture, env: { PATH: pathDir } })
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.path, fs.realpathSync(source))
  assert.equal(state.toolchain.source, 'linked')
})

for (const available of [true, false]) {
  test(`real fs: unrelated malformed wrapper ancestor with Toolchain ${available ? 'available' : 'absent'}`, (t) => {
    const fixture = diskFixture(t)
    const pathDir = path.join(fixture.root, 'wrappers', 'bin')
    const bin = path.join(pathDir, 'fh2-plugin')
    const globalRoot = path.join(fixture.root, 'global', 'node_modules')
    const global = path.join(globalRoot, ...TOOLCHAIN_PACKAGE.split('/'))
    writeFiles({ [bin]: '#!/bin/sh\nexit 0\n' })
    if (available) writeFiles(toolchainFiles(global))
    for (const unrelated of ['{broken', 'null', JSON.stringify({ name: 'unrelated-wrapper' })]) {
      fs.writeFileSync(path.join(path.dirname(pathDir), 'package.json'), unrelated)
      const state = resolveEnvironment({
        ...fixture,
        env: { PATH: pathDir },
        execFile: () => ({ stdout: `${globalRoot}\n` }),
      })
      assert.equal(state.execution.status, available ? 'ready' : 'bootstrap_required')
      assert.equal(state.toolchain.path, available ? fs.realpathSync(global) : null)
      assert.deepEqual(state.actions.map(item => item.action), available ? [] : ['install_toolchain'])
    }
  })
}

test('self-package identity with invalid version still fails closed outside official bin layout', () => {
  const source = '/repo/custom-toolchain'
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': `${source}/dist/cli.js` },
    files: {
      [`${source}/package.json`]: JSON.stringify({ name: TOOLCHAIN_PACKAGE }),
      ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
    },
    execFile: () => ({ stdout: '/usr/lib/node_modules\n' }),
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.toolchain.path, source)
  assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
})

test('self-package discovery ignores unrelated malformed metadata before a known valid package', () => {
  const source = '/repo/custom-toolchain'
  for (const unrelated of ['{broken', 'null', JSON.stringify({ name: 'unrelated-wrapper' })]) {
    const state = resolveEnvironment(fakeDeps({
      pathEnv: '/usr/local/bin',
      bins: ['/usr/local/bin/fh2-plugin'],
      realmap: { '/usr/local/bin/fh2-plugin': `${source}/dist/cli.js` },
      files: { [`${source}/dist/package.json`]: unrelated, ...toolchainFiles(source) },
    }))
    assert.equal(state.execution.status, 'ready')
    assert.equal(state.toolchain.path, source)
    assert.equal(state.toolchain.source, 'linked')
  }
})

test('official bin rejects metadata with wrong package identity', () => {
  const source = '/repo/custom-toolchain'
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/fh2-plugin'],
    realmap: { '/usr/local/bin/fh2-plugin': `${source}/bin/fh2-plugin.mjs` },
    files: {
      [`${source}/package.json`]: pkgJson('other-tool', '1.0.0'),
      ...toolchainFiles('/usr/lib/node_modules/fh2-plugin-toolchain'),
    },
    execFile: () => ({ stdout: '/usr/lib/node_modules\n' }),
  }))
  assert.equal(state.execution.status, 'broken_environment')
  assert.equal(state.toolchain.path, source)
  assert.deepEqual(state.actions.map(item => item.action), ['repair_toolchain'])
})

test('路径包含空格与非 ASCII 字符', () => {
  const state = resolveEnvironment(fakeDeps({
    cwd: '/tmp/my project/中文目录',
    files: {
      ...toolchainFiles('/tmp/my project/中文目录/node_modules/fh2-plugin-toolchain'),
    },
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.path, '/tmp/my project/中文目录/node_modules/fh2-plugin-toolchain')
})

test('registry 只读诊断：project 优先，其次 user，未配置为 null', () => {
  const withProject = resolveEnvironment(fakeDeps({
    files: { '/proj/.npmrc': 'registry=https://registry.npmmirror.com/\n@example:registry=https://packages.example.com/npm/\n' },
  }))
  assert.deepEqual(withProject.registry, { scope: '@example', url: 'https://packages.example.com/npm/', kind: 'custom', source: 'project' })

  const withUser = resolveEnvironment(fakeDeps({
    files: { '/workspace/test-user/.npmrc': '@example:registry=https://packages.example.com/npm/' },
  }))
  assert.equal(withUser.registry.source, 'user')
  assert.equal(withUser.registry.kind, 'custom')

  const withNone = resolveEnvironment(fakeDeps({}))
  assert.deepEqual(withNone.registry, { scope: null, url: null, kind: null, source: null })
})

test('registry 分类按实际 hostname：公开源 public、其他合法 URL custom', () => {
  const publicRegistry = resolveEnvironment(fakeDeps({
    files: { '/proj/.npmrc': '@example:registry=https://registry.npmjs.org/\n' },
  }))
  assert.equal(publicRegistry.registry.kind, 'public')

  const custom = resolveEnvironment(fakeDeps({
    files: { '/proj/.npmrc': '@example:registry=https://npm.mirror.example.com/\n' },
  }))
  assert.equal(custom.registry.kind, 'custom')
  assert.equal(custom.registry.url, 'https://npm.mirror.example.com/')
  assert.equal(classifyRegistryUrl('https://registry.npmjs.org.example.com/'), 'custom')
  assert.equal(classifyRegistryUrl('https://packages.example.com/registry.npmjs.org/'), 'custom')
  assert.equal(classifyRegistryUrl('https://REGISTRY.NPMJS.ORG/'), 'public')
  assert.equal(classifyRegistryUrl('file:///private/config'), null)
  assert.equal(classifyRegistryUrl('not-a-url'), null)
})

test('registry URL 和 npm 配置诊断不泄露凭据/query/hash 或认证行', () => {
  // Explicit test-only values populate actual credential positions at runtime.
  const fixture = {
    username: 'test-only-user',
    password: 'test-only-password',
    query: 'TOKEN_FOR_REDACTION_TEST',
    fragment: 'test-only-fragment',
    auth: 'TEST_AUTH_REDACTION_TOKEN',
    encoded: 'test-only-encoded',
    env: 'TEST_ENV_REDACTION_TOKEN',
  }
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/.npmrc': `@example:registry=https://${fixture.username}:${fixture.password}@packages.example.com/npm/?token=${fixture.query}#${fixture.fragment}\n`
        + `//packages.example.com/:_authToken=${fixture.auth}\n_password=${fixture.encoded}\n`,
    },
    env: { PATH: '', FH2_DEV_LOGIN_TOKEN: fixture.env },
  }))
  assert.deepEqual(state.registry, { scope: '@example', url: 'https://packages.example.com/npm/', kind: 'custom', source: 'project' })
  const output = JSON.stringify(state)
  for (const value of Object.values(fixture)) {
    assert.ok(!output.includes(value))
  }
})

test('通用 registry 保留只读诊断，注释不生效，重复键以最后值为准', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/.npmrc': '# @example:registry=https://ignored.example.com/\n; registry=https://ignored.example.com/\nregistry=https://old.example.com/\nregistry=https://registry.npmjs.org/\n',
      '/workspace/test-user/.npmrc': '@example:registry=https://user.example.com/\n',
    },
  }))
  assert.deepEqual(state.registry, { scope: null, url: 'https://registry.npmjs.org/', kind: 'public', source: 'project' })
  const invalid = resolveEnvironment(fakeDeps({ files: { '/proj/.npmrc': 'registry=not-a-url\n' } }))
  assert.deepEqual(invalid.registry, { scope: null, url: null, kind: null, source: 'project' })
})

test('SOURCE 探针不联网、推荐通道或修改 registry/安装包', () => {
  const calls = []
  let requests = 0
  const originalFetch = globalThis.fetch
  let state
  globalThis.fetch = () => {
    requests += 1
    throw new Error('network must not run')
  }
  try {
    state = resolveEnvironment({
      ...fakeDeps({ files: { '/proj/.npmrc': 'registry=https://packages.example.com/npm/\n' } }),
      execFile: (cmd, args) => {
        calls.push([cmd, args])
        return null
      },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(requests, 0)
  assert.ok(!('channelDetection' in state))
  assert.deepEqual(calls, [['npm', ['root', '-g']], ['pnpm', ['root', '-g']]])
  assert.deepEqual(state.registry, { scope: null, url: 'https://packages.example.com/npm/', kind: 'custom', source: 'project' })
  assert.ok(!state.actions.some(item => item.action === 'configure_registry'))
})

test('包管理器检测：已有工程按 lockfile 判定，优先于 PATH 偏好', () => {
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/npm', '/usr/local/bin/pnpm', '/proj/pnpm-lock.yaml'],
    execFile: (cmd, args) => (args[0] === '--version' ? { stdout: '10.15.0\n' } : null),
  }))
  assert.equal(state.packageManager.name, 'pnpm')
  assert.equal(state.packageManager.basis, 'lockfile')
})

test('包管理器检测：无 lockfile 时按 PATH 偏好 pnpm > npm > yarn', () => {
  const state = resolveEnvironment(fakeDeps({
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/npm', '/usr/local/bin/pnpm'],
    execFile: (cmd, args) => (args[0] === '--version' ? { stdout: '10.15.0\n' } : null),
  }))
  assert.equal(state.packageManager.name, 'pnpm')
  assert.equal(state.packageManager.version, '10.15.0')
  assert.equal(state.packageManager.basis, 'path')
})

test('包管理器检测：祖先层的游离 lockfile 不参与判定（需 package.json 佐证）', () => {
  const state = resolveEnvironment(fakeDeps({
    cwd: '/workspace/test-user/projects/new-plugin',
    pathEnv: '/usr/local/bin',
    bins: ['/usr/local/bin/npm', '/workspace/test-user/package-lock.json'],
  }))
  assert.equal(state.packageManager.name, 'npm')
  assert.equal(state.packageManager.basis, 'path')
})

test('Windows 模拟：PATH 条目带引号时可正常解析', () => {
  const state = resolveEnvironment(fakeDeps({
    platform: 'win32',
    cwd: 'C:\\proj',
    env: {
      Path: `"C:\\Program Files\\nodejs";${WINDOWS_NPM_ROOT}`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    files: {
      ...toolchainFiles(path.win32.join(WINDOWS_NPM_ROOT, 'node_modules', ...TOOLCHAIN_PACKAGE.split('/')), '0.1.0', '0.2.0-fixture', path.win32),
    },
    bins: [path.win32.join(WINDOWS_NPM_ROOT, 'fh2-plugin.cmd')],
  }))
  assert.equal(state.execution.status, 'ready')
  assert.equal(state.toolchain.source, 'global')
})

test('工程边界字段：识别 package.json 与 fh2-plugin.json', () => {
  const state = resolveEnvironment(fakeDeps({
    files: {
      '/proj/package.json': pkgJson('proj', '1.0.0'),
      '/proj/fh2-plugin.json': '{}',
    },
  }))
  assert.equal(state.project.hasPackageJson, true)
  assert.equal(state.project.hasFh2Manifest, true)
  assert.equal(state.project.hasNodeModules, false)
})

test('真实进程冒烟：脚本可直接执行并输出合法 JSON', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resolve-env.cjs')
  const result = spawnSync(process.execPath, [scriptPath, '--project', __dirname], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.status, 0, result.stderr)
  const state = JSON.parse(result.stdout)
  assert.equal(state.schemaVersion, 3)
  assert.equal(state.planning.status, 'ready')
  assert.ok(state.contract !== undefined && 'path' in state.contract && 'source' in state.contract)
  assert.ok(['ready', 'bootstrap_required', 'node_upgrade_required', 'broken_environment'].includes(state.execution.status))
})

test('CLI 参数校验：--project 缺值时退出码为 2', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resolve-env.cjs')
  const result = spawnSync(process.execPath, [scriptPath, '--project'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.status, 2)
  assert.ok(String(result.stderr).includes('--project'))
})

test('CLI 不接受网络通道探测、未知参数或重复工程参数', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resolve-env.cjs')
  for (const args of [['--probe-network'], ['--unknown'], ['constructor', __dirname], ['toString', __dirname], ['--project', __dirname, '--project', __dirname], ['--platform-root'], ['--platform-root', __dirname, '--platform-root', __dirname], ['--platform-root', '--project', __dirname]]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }
  const help = spawnSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes('只检查 manifest'))
  assert.ok(help.stdout.includes('--platform-root'))
  assert.ok(!help.stdout.includes('--probe-network'))
})
