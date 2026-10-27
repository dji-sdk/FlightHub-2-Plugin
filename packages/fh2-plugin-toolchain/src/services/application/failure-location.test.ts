// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDevCommand } from '../../commands/dev-command.js'
import { parsePreviewArguments, runPreviewCommand } from '../../commands/preview-command.js'
import { runTypesCommand } from '../../commands/types-command.js'
import { runValidateCommand } from '../../commands/validate-command.js'
import { failureLocationHint, isMissingPathError } from './failure-location.js'
import { previewProject } from './preview.js'

const roots: string[] = []
function fixture (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-location-hint-'))
  roots.push(root)
  return root
}
function file (root: string, path: string, value: unknown): void {
  writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
}
function capture () {
  const stdout = { text: '', write (value: string) {
    this.text += value
  } }
  const stderr = { text: '', write (value: string) {
    this.text += value
  } }
  return { stdout, stderr, signals: new EventEmitter() }
}
function quoted (path: string): string {
  return process.platform === 'win32' ? `"${path}"` : `'${path}'`
}
function capability (root: string): { root: string; frontend: string; backend: string } {
  file(root, 'capabilities.json', { name: 'test', description: 'test' })
  const frontend = join(root, 'frontend', 'exp_frontend')
  const backend = join(root, 'backend', 'exp_backend')
  mkdirSync(frontend, { recursive: true })
  mkdirSync(backend, { recursive: true })
  file(frontend, 'fh2-plugin.json', { id: 'exp_frontend', entry: './plugin.js' })
  file(backend, 'fh2-plugin.json', { pluginId: 'exp_backend', flows: [] })
  return { root, frontend, backend }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('只读失败位置提示', () => {
  it('解释缺失/文件目录，不创建文件或目录', () => {
    const root = fixture()
    const missing = join(root, 'missing')
    file(root, 'file', 'plain')
    expect(failureLocationHint('dev', missing)).toContain(`目标目录不存在：${missing}`)
    expect(failureLocationHint('preview', join(root, 'file'))).toContain('目标不是目录')
    expect(existsSync(missing)).toBe(false)
    expect(readdirSync(root)).toEqual(['file'])
  })

  it('源清单或能力标志存在时不把配置/坏 JSON 问题误判为错误目录', () => {
    const root = fixture()
    file(root, 'fh2-plugin.json', '{ broken')
    expect(failureLocationHint('dev', root)).toBe('')
    file(root, 'capabilities.json', '{ broken')
    expect(failureLocationHint('validate', root)).toBe('')
  })

  it('成员父目录列出真实成员，使用带引号的绝对路径，不自动回退', () => {
    const root = fixture()
    const cap = capability(root)
    const parent = join(root, 'frontend')
    const before = readdirSync(parent)
    const hint = failureLocationHint('dev', parent)
    expect(hint).toContain('frontend 成员父目录')
    expect(hint).toContain(`fh2-plugin dev cockpit --root ${quoted(cap.frontend)}`)
    expect(hint).not.toContain('run dev:cockpit')
    expect(readdirSync(parent)).toEqual(before)
    expect(existsSync(join(root, '.fh2'))).toBe(false)
  })

  it('types 的父目录提示只列后端成员，不建议对前端运行 types', () => {
    const root = fixture()
    const cap = capability(root)
    const hint = failureLocationHint('types', join(root, 'frontend'))
    expect(hint).toContain(`fh2-plugin types --root ${quoted(cap.backend)}`)
    expect(hint).not.toContain(`--root ${quoted(cap.frontend)}`)
  })

  it('工作区不自动选择成员，仅已确认的包管理器/脚本可获得脚本建议', () => {
    const root = fixture()
    file(root, 'packages.json', { packageId: 'exp_package', capabilityIds: ['exp_a', 'exp_b'] })
    for (const name of ['exp_a', 'exp_b']) {
      mkdirSync(join(root, name))
      capability(join(root, name))
    }
    expect(failureLocationHint('dev', root)).not.toContain('run dev:cockpit')
    file(root, 'package.json', { packageManager: 'pnpm@10.15.0', scripts: { 'dev:cockpit': 'fh2-plugin dev cockpit --root exp_a' } })
    const hint = failureLocationHint('dev', root)
    expect(hint).toContain(`cd${process.platform === 'win32' ? ' /d' : ''} ${quoted(root)} && pnpm run dev:cockpit`)
    expect(hint).toContain(`--root ${quoted(join(root, 'exp_a'))}`)
    expect(hint).toContain(`--root ${quoted(join(root, 'exp_b'))}`)
    expect(failureLocationHint('preview', root)).not.toContain('run dev:cockpit')
  })

  it.each(['npm', 'yarn'])('脚本提示尊重所选包管理器 %s', (manager) => {
    const root = fixture()
    file(root, 'packages.json', {})
    file(root, 'package.json', { packageManager: `${manager}@1.0.0`, scripts: { 'dev:cockpit': 'command' } })
    expect(failureLocationHint('dev', root)).toContain(`${manager} run dev:cockpit`)
  })

  it('损坏 package.json 不影响原错误或成员路径建议', () => {
    const root = fixture()
    file(root, 'packages.json', {})
    file(root, 'package.json', '{ broken')
    expect(failureLocationHint('dev', root)).toContain('工作区根')
    expect(failureLocationHint('dev', root)).not.toContain('run dev:cockpit')
  })

  it('非普通 package.json 不被读取或作为脚本建议', () => {
    const root = fixture()
    file(root, 'packages.json', {})
    mkdirSync(join(root, 'package.json'))
    expect(failureLocationHint('dev', root)).toContain('工作区根')
    expect(failureLocationHint('dev', root)).not.toContain('run dev:cockpit')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('无权查询子路径时不误报工程标志不存在', () => {
    const root = fixture()
    file(root, 'fh2-plugin.json', '{}')
    chmodSync(root, 0o600)
    try {
      expect(failureLocationHint('dev', root)).toBe('')
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('windows 提示使用 cmd 双引号和跨盘 cd /d', () => {
    const root = fixture()
    file(root, 'packages.json', {})
    file(root, 'package.json', { packageManager: 'pnpm@10.15.0', scripts: { 'dev:cockpit': 'command' } })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      expect(failureLocationHint('dev', root)).toContain(`cd /d "${root}" && pnpm run dev:cockpit`)
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('legacy pack 结构不追加工程身份误导', () => {
    const root = fixture()
    mkdirSync(join(root, 'plugins'))
    expect(failureLocationHint('pack', root)).toBe('')
  })

  it('开发工具目录与普通目录仅得到提示，不取锁或加载配置', () => {
    const root = fixture()
    expect(failureLocationHint('dev', root)).toContain('没有 packages.json')
    file(root, 'public-distribution.json', {})
    expect(failureLocationHint('dev', root)).toContain('插件开发工具根')
    expect(existsSync(join(root, '.fh2'))).toBe(false)
  })

  it('权限错误不是缺失目录，非 Error 保持原处理', () => {
    expect(isMissingPathError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false)
    expect(isMissingPathError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true)
    expect(isMissingPathError({ code: 'ENOENT' })).toBe(false)
  })
})

describe('失败边界保留原命令行为', () => {
  it('dev 取锁前根缺失仍抛原 ENOENT，同时说明实际位置且不启动构建', async () => {
    const root = fixture()
    const target = join(root, 'missing')
    const io = capture()
    const createRunner = vi.fn()
    await expect(runDevCommand({ args: ['--root', target], cwd: root, ...io, env: {}, createRunner }))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(io.stderr.text).toContain(`目标目录不存在：${target}`)
    expect(createRunner).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(false)
  })

  it('dev 错误成员父目录保留构建错误和退出码，不先拒绝或改目标', async () => {
    const root = fixture()
    capability(root)
    const parent = join(root, 'frontend')
    const io = capture()
    const createRunner = vi.fn(async () => {
      throw new Error('FH2_ADAPTER_COUNT_INVALID')
    })
    const result = await runDevCommand({ args: [], cwd: parent, ...io, env: {}, createRunner, operationLockHeld: true })
    expect(result).toBe(3)
    expect(createRunner).toHaveBeenCalledWith(expect.objectContaining({ cwd: parent }))
    expect(io.stderr.text).toContain('frontend 成员父目录')
    expect(io.stderr.text).toContain('FH2_ADAPTER_COUNT_INVALID')
  })

  it('preview 多目标锁失败释放先取得的锁，保留原抛出错误', async () => {
    const root = fixture()
    const first = join(root, 'a')
    mkdirSync(first)
    file(first, 'fh2-plugin.json', { id: 'exp_a', entry: './plugin.js' })
    const missing = join(root, 'z_missing')
    const io = capture()
    const parsed = parsePreviewArguments(['--plugin', first, '--plugin', missing], root)
    await expect(previewProject(parsed, { cwd: root, ...io })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(io.stderr.text).toContain(`目标目录不存在：${missing}`)
    expect(existsSync(join(first, '.fh2'))).toBe(false)
    expect(existsSync(missing)).toBe(false)
  })

  it('preview 工作区构建失败保留 adapter 诊断、退出码和未启动的 server', async () => {
    const root = fixture()
    file(root, 'packages.json', {})
    const io = capture()
    const createRunner = vi.fn(async () => {
      throw new Error('FH2_ADAPTER_COUNT_INVALID')
    })
    const serve = vi.fn()
    expect(await runPreviewCommand({
      args: ['--fh2-url', 'http://fh2.example/project', '--no-open'],
      cwd: root,
      ...io,
      operationLockHeld: true,
      createRunner,
      serve,
    })).toBe(3)
    expect(io.stderr.text).toContain('工作区根')
    expect(io.stderr.text).toContain('FH2_ADAPTER_COUNT_INVALID')
    expect(serve).not.toHaveBeenCalled()
  })

  it('默认 Manifest 缺失时 JSON 信封不变，提示仅出现在 stderr', async () => {
    const root = fixture()
    const io = capture()
    expect(await runValidateCommand({ args: ['--format', 'json'], cwd: root, ...io })).toBe(1)
    const result = JSON.parse(io.stdout.text)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0].code).toBe('FH2_MANIFEST_READ_FAILED')
    expect(io.stdout.text).not.toContain('位置提示')
    expect(io.stderr.text).toContain('位置提示')
  })

  it('types 缺清单打印正确源文件名并定位后端成员', () => {
    const root = fixture()
    const cap = capability(root)
    const io = capture()
    expect(runTypesCommand({ args: [], cwd: root, ...io })).toBe(1)
    expect(io.stderr.text.split('\n')[0]).toBe(`未找到后端插件清单：${join(root, 'fh2-plugin.json')}`)
    expect(io.stderr.text).toContain(cap.backend)
    expect(existsSync(join(root, 'types'))).toBe(false)
  })

  it('types 不拒绝 fallback frontend 的最小合法后端输入', () => {
    const root = fixture()
    file(root, 'fh2-plugin.json', { pluginId: 'exp_handler_only', name: 'handler only', version: '1.0.0', allowlist: ['data:read'] })
    const io = capture()
    expect(runTypesCommand({ args: [], cwd: root, ...io })).toBe(0)
    expect(existsSync(join(root, 'types'))).toBe(true)
    expect(runTypesCommand({ args: ['--check'], cwd: root, ...capture() })).toBe(0)
    expect(io.stderr.text).toBe('')
  })
})
