// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { Buffer } from 'node:buffer'
import { ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typecheckBackendProject, typecheckFrontendProject } from './run.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProject (files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-typecheck-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

describe('typecheckFrontendProject（B2a）', () => {
  it('普通 TS：类型错误被检测，行列 1-based，noEmit 不写产物', async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }),
      'main.ts': 'export const value: number = "not a number"\n',
    })

    const result = await typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: false })

    expect(result.executed).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]).toMatchObject({
      code: 'TS2322',
      file: 'main.ts',
      line: 1,
      severity: 'error',
    })
    expect(result.diagnostics[0]!.column).toBeGreaterThan(0)
  })

  it('合法工程通过', async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }),
      'main.ts': 'export const value: number = 42\n',
    })

    const result = await typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: false })

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  it('缺少 tsconfig：明确诊断，不标 typechecked', async () => {
    const root = await createProject({ 'main.ts': 'export const value = 1\n' })

    const result = await typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: false })

    expect(result.executed).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({ code: 'FH2_TYPECHECK_CONFIG_MISSING' })
  })

  it('含 .vue：走 vue-tsc 子进程并解析 stdout 诊断', { timeout: 60_000 }, async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['*.ts', '*.vue'],
      }),
      'main.ts': 'export const value: number = 1\n',
      'App.vue': '<script setup lang="ts">\nconst count: number = "oops"\n</script>\n<template><div>{{ count }}</div></template>\n',
    })

    const result = await typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: true })

    expect(result.executed).toBe(true)
    expect(result.ok).toBe(false)
    const vueDiagnostic = result.diagnostics.find(diagnostic => diagnostic.file.endsWith('.vue'))
    expect(vueDiagnostic).toBeDefined()
    expect(vueDiagnostic!.severity).toBe('error')
    expect(vueDiagnostic!.line).toBeGreaterThan(0)
  })

  it('vue-tsc 的真实无文件位置诊断保留 TS2688 错误码', { timeout: 60_000 }, async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { types: ['vitest'] }, include: ['*.ts'] }),
      'main.ts': 'export const value = 1\n',
    })
    const result = await typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: true })

    expect(result).toMatchObject({ ok: false, executed: true })
    expect(result.diagnostics).toContainEqual({
      code: 'TS2688',
      phase: 'typecheck',
      file: '.',
      message: 'Cannot find type definition file for \'vitest\'.',
      severity: 'error',
    })
  })

  it('abortSignal 已中止：进入即抛错，不启动子进程', async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }),
      'main.ts': 'export const value: number = 1\n',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: false, abortSignal: controller.signal })).rejects.toThrow(/取消/)
  })

  it('abortSignal 运行中止：挂起的 vue-tsc 子进程被终止且以取消错误收场', { timeout: 60_000 }, async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['*.ts', '*.vue'],
      }),
      'main.ts': 'export const value: number = 1\n',
      'App.vue': '<script setup lang="ts">\nconst count: number = 1\n</script>\n<template><div>{{ count }}</div></template>\n',
    })
    const controller = new AbortController()
    const pending = typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: true, abortSignal: controller.signal })
    // 等一小段让 vue-tsc 子进程真实启动，再发出取消
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort()
    await expect(pending).rejects.toThrow(/取消/)
  })
})

describe('vue-tsc 输出流回归', () => {
  async function runCompilerOutput (
    output: { stdout?: readonly Buffer[]; stderr?: readonly Buffer[] },
    code: number | null = 2,
    signal: NodeJS.Signals | null = null,
  ) {
    const root = await createProject({ 'tsconfig.json': '{}' })
    const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() })
    vi.mocked(spawn).mockReturnValueOnce(child)
    const pending = typecheckFrontendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json'), hasVue: true })
    for (const chunk of output.stdout ?? []) child.stdout.write(chunk)
    for (const chunk of output.stderr ?? []) child.stderr.write(chunk)
    child.stdout.end()
    child.stderr.end()
    await Promise.all([finished(child.stdout), finished(child.stderr)])
    child.emit('close', code, signal)
    return await pending
  }

  it('跨 chunk 行、中文 UTF-8 字节边界与 CRLF 保持完整', async () => {
    const text = 'src/面板.vue(2,7): error TS2322: 类型错误\r\n'
    const bytes = Buffer.from(text)
    const messageStart = Buffer.byteLength('src/面板.vue(2,7): error TS2322: ')
    const result = await runCompilerOutput({
      stdout: [bytes.subarray(0, 5), bytes.subarray(5, messageStart + 1), bytes.subarray(messageStart + 1, bytes.length - 1), bytes.subarray(bytes.length - 1)],
    })

    expect(result).toMatchObject({ ok: false, executed: true })
    expect(result.diagnostics).toEqual([{
      code: 'TS2322',
      phase: 'typecheck',
      file: 'src/面板.vue',
      line: 2,
      column: 7,
      message: '类型错误',
      severity: 'error',
    }])
  })

  it('stdout/stderr 分别缓冲并在 close 刷出没有换行的尾行', async () => {
    const result = await runCompilerOutput({
      stdout: [Buffer.from('main.ts(3,4): error TS2322: bad '), Buffer.from('type')],
      stderr: [Buffer.from('error TS2304: Cannot find name \'vitest\'')],
    })

    expect(result.diagnostics).toEqual([
      { code: 'TS2322', phase: 'typecheck', file: 'main.ts', line: 3, column: 4, message: 'bad type', severity: 'error' },
      { code: 'TS2304', phase: 'typecheck', file: '.', message: 'Cannot find name \'vitest\'', severity: 'error' },
    ])
  })

  it('非零且不可解析时保留受限的原始错误尾部，不返回 0 条诊断', async () => {
    const result = await runCompilerOutput({
      stderr: [Buffer.from(`${'obsolete output\n'.repeat(1000)}Fatal: worker crashed\n原始错误：缺少依赖`)],
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ code: 'FH2_TYPECHECK_TOOL_FAILED', phase: 'typecheck', file: '.', severity: 'error' })
    expect(result.diagnostics[0]!.message).toContain('退出码 2')
    expect(result.diagnostics[0]!.message).toContain('Fatal: worker crashed\n原始错误：缺少依赖')
    expect(result.diagnostics[0]!.message.length).toBeLessThanOrEqual(4200)
  })

  it.each([
    [2, null],
    [null, 'SIGTERM'],
  ] as const)('没有输出的失败仍有诊断（code=%s signal=%s）', async (code, signal) => {
    const result = await runCompilerOutput({}, code, signal)

    expect(result).toMatchObject({ ok: false, executed: true })
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'FH2_TYPECHECK_TOOL_FAILED', severity: 'error', message: expect.stringMatching(/退出码 2|SIGTERM/) })])
  })

  it('只有 warning 的非零退出补错误，成功输出不伪造错误', async () => {
    const output = { stdout: [Buffer.from('warning TS1234: compiler warning\n')] }
    const failed = await runCompilerOutput(output)
    expect(failed.ok).toBe(false)
    expect(failed.diagnostics).toEqual([
      expect.objectContaining({ code: 'TS1234', severity: 'warning' }),
      expect.objectContaining({ code: 'FH2_TYPECHECK_TOOL_FAILED', severity: 'error' }),
    ])
    const passed = await runCompilerOutput(output, 0)
    expect(passed.ok).toBe(true)
    expect(passed.diagnostics).toEqual([expect.objectContaining({ code: 'TS1234', severity: 'warning' })])
    expect(await runCompilerOutput({}, 0)).toEqual({ ok: true, executed: true, diagnostics: [] })
  })
})

describe('typecheckBackendProject（B2b）', () => {
  it('后端 TS 源码类型错误被检测（Goja 无 DOM：DOM 全局报错）', async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['handlers/**/*.ts'],
      }),
      'handlers/issue.ts': 'export function createIssue(): number {\n  return document.title.length\n}\n',
    })

    const result = await typecheckBackendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json') })

    expect(result.executed).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some(diagnostic => diagnostic.code === 'TS2584' && diagnostic.severity === 'error')).toBe(true)
  })

  it('依赖生成类型的后端源码通过', async () => {
    const root = await createProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['handlers/**/*.ts', 'types/**/*.ts'],
      }),
      'types/handler.d.ts': 'declare const ctx: { readonly storage: { get(key: string): string | undefined } }\n',
      'handlers/issue.ts': 'export function createIssue(): string {\n  return ctx.storage.get("issue") ?? "none"\n}\n',
    })

    const result = await typecheckBackendProject({ projectRoot: root, tsconfigPath: join(root, 'tsconfig.json') })

    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
  })
})
