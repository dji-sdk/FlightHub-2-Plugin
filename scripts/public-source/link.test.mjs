// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { linkSource, stripWindowsDevicePrefix } from './link.mjs'

const silentStdout = { write () {} }

function makeFixture () {
  const root = mkdtempSync(join(tmpdir(), 'fh2-link-test-'))
  const sourceRoot = join(root, 'source')
  const packageRoot = join(sourceRoot, 'packages', 'fh2-plugin-toolchain')
  const sdkRoot = join(sourceRoot, 'packages', 'fh2-plugin-sdk')
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(sdkRoot, 'dist'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fh2-plugin-toolchain', bin: { 'fh2-plugin': 'bin/fh2-plugin.mjs' } }))
  writeFileSync(join(packageRoot, 'bin', 'fh2-plugin.mjs'), '#!/usr/bin/env node\n')
  for (const rel of ['dist/cli.js', 'apps/fh2-web-ide/dist/index.html', 'apps/mock-host-workbench-shell/dist/index.html', 'apps/mock-host-vue2/dist/container.html', 'apps/mock-host-vue3/dist/container.html']) {
    mkdirSync(dirname(join(packageRoot, rel)), { recursive: true })
    writeFileSync(join(packageRoot, rel), '')
  }
  writeFileSync(join(sdkRoot, 'dist', 'index.js'), '')
  const prefix = join(root, 'global-prefix')
  mkdirSync(prefix, { recursive: true })
  return { root, sourceRoot, packageRoot, prefix }
}

/** 模拟 Windows npm link 产物：junction（mac 上以 dir symlink 等价模拟）+ 三个普通文件 cmd-shim。 */
function registerWin32 (fixture, { shimContent } = {}) {
  const globalPackage = join(fixture.prefix, 'node_modules', 'fh2-plugin-toolchain')
  mkdirSync(dirname(globalPackage), { recursive: true })
  symlinkSync(fixture.packageRoot, globalPackage, 'dir')
  const content = shimContent ?? '@"%~dp0\\node_modules\\fh2-plugin-toolchain\\bin\\fh2-plugin.mjs" %*\n'
  for (const name of ['fh2-plugin', 'fh2-plugin.cmd', 'fh2-plugin.ps1']) {
    writeFileSync(join(fixture.prefix, name), content)
  }
  return globalPackage
}

/** npm 假 spawn：prefix 探测返回 fixture prefix，link/unlink 记录调用。 */
function fakeNpm (fixture) {
  const calls = []
  const spawn = (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'prefix') return { status: 0, stdout: `${fixture.prefix}\n` }
    return { status: 0 }
  }
  return { calls, spawn }
}

function linkOptions (fixture, npm, overrides = {}) {
  return {
    sourceRoot: fixture.sourceRoot,
    spawn: npm.spawn,
    stdout: silentStdout,
    verifySource: () => {},
    platform: 'win32',
    ...overrides,
  }
}

test('win32：全新 prefix 完成 link，PATH 提示指向 prefix 根（shim 在根目录）', () => {
  const fixture = makeFixture()
  try {
    const npm = fakeNpm(fixture)
    const lines = []
    const result = linkSource(linkOptions(fixture, npm, { stdout: { write: line => lines.push(line) } }))
    assert.equal(result.prefix, fixture.prefix)
    assert.ok(npm.calls.some(([command, action]) => command === 'npm' && action === 'link'))
    assert.ok(lines.some(line => line.includes(fixture.prefix) && line.includes('PATH')))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：已有本包注册（junction + cmd-shim 普通文件）重复 link 无冲突', () => {
  const fixture = makeFixture()
  try {
    registerWin32(fixture)
    const npm = fakeNpm(fixture)
    linkSource(linkOptions(fixture, npm))
    assert.ok(npm.calls.some(([command, action]) => command === 'npm' && action === 'link'))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：外部工具的 shim 报 FH2_LINK_CONFLICT；--replace-existing 拒绝删除外部文件', () => {
  const fixture = makeFixture()
  try {
    registerWin32(fixture, { shimContent: '@echo other-tool\n' })
    const npm = fakeNpm(fixture)
    assert.throws(() => linkSource(linkOptions(fixture, npm)), error => error.code === 'FH2_LINK_CONFLICT')
    const foreign = join(fixture.prefix, 'fh2-plugin.cmd')
    assert.throws(
      () => linkSource(linkOptions(fixture, npm, { replaceExisting: true })),
      error => error.code === 'FH2_LINK_UNRELATED',
    )
    assert.ok(existsSync(foreign), '外部 shim 不能被删除')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：npm install -g 的真实目录形态报冲突；--replace-existing 拒绝覆盖安装拷贝', () => {
  const fixture = makeFixture()
  try {
    const globalPackage = join(fixture.prefix, 'node_modules', 'fh2-plugin-toolchain')
    mkdirSync(globalPackage, { recursive: true })
    writeFileSync(join(globalPackage, 'package.json'), '{"name":"fh2-plugin-toolchain"}')
    for (const name of ['fh2-plugin', 'fh2-plugin.cmd', 'fh2-plugin.ps1']) {
      writeFileSync(join(fixture.prefix, name), '@"%~dp0\\node_modules\\fh2-plugin-toolchain\\bin\\fh2-plugin.mjs" %*\n')
    }
    const npm = fakeNpm(fixture)
    assert.throws(() => linkSource(linkOptions(fixture, npm)), error => error.code === 'FH2_LINK_CONFLICT')
    assert.throws(
      () => linkSource(linkOptions(fixture, npm, { replaceExisting: true })),
      error => error.code === 'FH2_LINK_UNRELATED',
    )
    assert.ok(existsSync(join(globalPackage, 'package.json')), '真实安装目录不能被删除')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：悬空 junction + 本包 shim，--replace-existing 清理配对后重新 link', () => {
  const fixture = makeFixture()
  try {
    const globalPackage = join(fixture.prefix, 'node_modules', 'fh2-plugin-toolchain')
    mkdirSync(dirname(globalPackage), { recursive: true })
    symlinkSync(join(fixture.root, 'gone-source', 'packages', 'fh2-plugin-toolchain'), globalPackage, 'dir')
    for (const name of ['fh2-plugin', 'fh2-plugin.cmd', 'fh2-plugin.ps1']) {
      writeFileSync(join(fixture.prefix, name), '@"%~dp0\\node_modules\\fh2-plugin-toolchain\\bin\\fh2-plugin.mjs" %*\n')
    }
    const npm = fakeNpm(fixture)
    const lines = []
    linkSource(linkOptions(fixture, npm, { replaceExisting: true, stdout: { write: line => lines.push(line) } }))
    assert.ok(!existsSync(globalPackage), '悬空 junction 已清理')
    for (const name of ['fh2-plugin', 'fh2-plugin.cmd', 'fh2-plugin.ps1']) {
      assert.ok(!existsSync(join(fixture.prefix, name)), `${name} 已清理`)
    }
    assert.ok(npm.calls.some(([command, action]) => command === 'npm' && action === 'link'))
    assert.ok(lines.some(line => line.includes('悬空')))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：解除本包注册调用 npm unlink --global', () => {
  const fixture = makeFixture()
  try {
    registerWin32(fixture)
    const npm = fakeNpm(fixture)
    linkSource(linkOptions(fixture, npm, { unlink: true }))
    assert.ok(npm.calls.some(call => call[0] === 'npm' && call[1] === 'unlink' && call[2] === '--global' && call[3] === 'fh2-plugin-toolchain'))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('win32：解除外部安装（真实目录）报 FH2_UNLINK_NOT_OWNED', () => {
  const fixture = makeFixture()
  try {
    const globalPackage = join(fixture.prefix, 'node_modules', 'fh2-plugin-toolchain')
    mkdirSync(globalPackage, { recursive: true })
    const npm = fakeNpm(fixture)
    assert.throws(() => linkSource(linkOptions(fixture, npm, { unlink: true })), error => error.code === 'FH2_UNLINK_NOT_OWNED')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('posix 回归：符号链接形态的既有注册重复 link 无冲突', () => {
  const fixture = makeFixture()
  try {
    const globalPackage = join(fixture.prefix, 'lib', 'node_modules', 'fh2-plugin-toolchain')
    mkdirSync(dirname(globalPackage), { recursive: true })
    symlinkSync(fixture.packageRoot, globalPackage, 'dir')
    mkdirSync(join(fixture.prefix, 'bin'), { recursive: true })
    symlinkSync(join(fixture.packageRoot, 'bin', 'fh2-plugin.mjs'), join(fixture.prefix, 'bin', 'fh2-plugin'))
    const npm = fakeNpm(fixture)
    linkSource(linkOptions(fixture, npm, { platform: 'darwin' }))
    assert.ok(npm.calls.some(([command, action]) => command === 'npm' && action === 'link'))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('stripWindowsDevicePrefix：剥掉 \\\\?\\ 前缀，UNC 还原为 \\\\server 形态', () => {
  assert.equal(stripWindowsDevicePrefix('\\\\?\\C:\\Users\\x\\packages\\fh2-plugin-toolchain'), 'C:\\Users\\x\\packages\\fh2-plugin-toolchain')
  assert.equal(stripWindowsDevicePrefix('\\\\?\\UNC\\server\\share\\pkg'), '\\\\server\\share\\pkg')
  assert.equal(stripWindowsDevicePrefix('C:\\plain\\path'), 'C:\\plain\\path')
})
