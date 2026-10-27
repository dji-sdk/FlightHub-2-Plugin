// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runTypesCommand } from './types-command.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('types command', () => {
  it('--help returns before reading a manifest or generating types', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-types-help-'))
    roots.push(root)
    writeFileSync(join(root, 'fh2-plugin.json'), '{ invalid manifest')
    const io = capturedIo()
    expect(runTypesCommand({ args: ['--help'], cwd: root, ...io })).toBe(0)
    expect(io.stdout.text).toContain('用法：fh2-plugin types')
    expect(io.stderr.text).toBe('')
    expect(existsSync(join(root, 'types'))).toBe(false)
    expect(runTypesCommand({ args: ['--help'], cwd: join(root, 'missing'), ...capturedIo() })).toBe(0)
  })
  it('只生成 Host 注入面声明，并清理旧的 schema facade', () => {
    const root = mkdtempSync(join(tmpdir(), 'fh2-types-command-'))
    roots.push(root)
    writeFileSync(join(root, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'types_command_fixture',
      name: 'types command fixture',
      version: '0.1.0',
      entities: [{ name: 'example_record', fields: { title: { type: 'string' } } }],
      allowlist: ['data:read', 'data:write'],
    }))

    const write = capturedIo()
    expect(runTypesCommand({ args: [], cwd: root, ...write })).toBe(0)
    expect(existsSync(join(root, 'types/handler.d.ts'))).toBe(true)
    expect(existsSync(join(root, 'types/entities.d.ts'))).toBe(false)
    expect(existsSync(join(root, 'types/storage.ts'))).toBe(false)

    const current = capturedIo()
    expect(runTypesCommand({ args: ['--check'], cwd: root, ...current })).toBe(0)

    writeFileSync(join(root, 'types/storage.ts'), 'export {}\n')
    const check = capturedIo()
    expect(runTypesCommand({ args: ['--check'], cwd: root, ...check })).toBe(1)
    expect(check.stderr.text).toContain('types/storage.ts 不在生成清单内')

    expect(runTypesCommand({ args: [], cwd: root, ...capturedIo() })).toBe(0)
    expect(existsSync(join(root, 'types/storage.ts'))).toBe(false)

    // 非工具拥有的文件不能被生成器删除或判为过期。
    writeFileSync(join(root, 'types/custom.ts'), 'export {}\n')
    expect(runTypesCommand({ args: ['--check'], cwd: root, ...capturedIo() })).toBe(0)
    expect(existsSync(join(root, 'types/custom.ts'))).toBe(true)
  })
})

function capturedIo (): { readonly stdout: CaptureWriter; readonly stderr: CaptureWriter } {
  return { stdout: new CaptureWriter(), stderr: new CaptureWriter() }
}

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}
