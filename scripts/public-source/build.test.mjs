// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteWindowsArg, runSourceCommand } from './build.mjs'

const silentStdout = { write () {} }

function fakeSpawn (result = { status: 0 }) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return result
  }
  return { calls, spawn }
}

test('posix 平台 shell:false，命令与参数原样传递', () => {
  const { calls, spawn } = fakeSpawn()
  runSourceCommand('pnpm', ['--filter', 'fh2-plugin-sdk', 'run', 'build'], { cwd: '/tmp/x', spawn, stdout: silentStdout, platform: 'darwin' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'pnpm')
  assert.deepEqual(calls[0].args, ['--filter', 'fh2-plugin-sdk', 'run', 'build'])
  assert.equal(calls[0].options.shell, false)
})

test('win32：shell:true（pnpm/npm 是 .cmd shim，需经 cmd.exe 按 PATHEXT 解析）', () => {
  const { calls, spawn } = fakeSpawn()
  runSourceCommand('pnpm', ['--filter', 'fh2-plugin-sdk', 'run', 'build'], { cwd: 'C:\\repo', spawn, stdout: silentStdout, platform: 'win32' })
  assert.equal(calls[0].options.shell, true)
  assert.deepEqual(calls[0].args, ['--filter', 'fh2-plugin-sdk', 'run', 'build'])
})

test('win32：含空格的命令与参数都被 cmd 引号包裹（Node 装在含空格路径）', () => {
  const { calls, spawn } = fakeSpawn()
  runSourceCommand('C:\\Program Files\\nodejs\\node.exe', ['C:\\repo with space\\scripts\\copy-workbench.mjs'], { cwd: 'C:\\repo with space', spawn, stdout: silentStdout, platform: 'win32' })
  assert.equal(calls[0].command, '"C:\\Program Files\\nodejs\\node.exe"')
  assert.deepEqual(calls[0].args, ['"C:\\repo with space\\scripts\\copy-workbench.mjs"'])
})

test('win32：无空格参数不加引号，普通 token 不受影响', () => {
  assert.equal(quoteWindowsArg('fh2-plugin-sdk'), 'fh2-plugin-sdk')
  assert.equal(quoteWindowsArg('a b'), '"a b"')
  assert.equal(quoteWindowsArg('a"b'), '"a""b"')
})

test('spawn ENOENT 抛 FH2_SOURCE_COMMAND 并提示检查 PATH', () => {
  const { spawn } = fakeSpawn({ error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  assert.throws(
    () => runSourceCommand('pnpm', ['--version'], { cwd: '/tmp/x', spawn, stdout: silentStdout, platform: 'win32' }),
    error => error.code === 'FH2_SOURCE_COMMAND' && error.message.includes('不可用') && error.message.includes('PATH'),
  )
})

test('非零退出码：exitCode 附加到错误上', () => {
  const { spawn } = fakeSpawn({ status: 1 })
  assert.throws(
    () => runSourceCommand('pnpm', ['run', 'build'], { cwd: '/tmp/x', spawn, stdout: silentStdout, platform: 'darwin' }),
    error => error.code === 'FH2_SOURCE_COMMAND' && error.exitCode === 1,
  )
})
