// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as capabilityBuild from '../capability/build.js'
import { parseBuildArguments, runBuildCommand } from './build-command.js'
import { runPackCommand } from './pack-command.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class Signals {
  private readonly listeners = new Map<string, Set<() => void>>()

  on (signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    const set = this.listeners.get(signal) ?? new Set()
    set.add(listener)
    this.listeners.set(signal, set)
  }

  off (signal: 'SIGINT' | 'SIGTERM', listener: () => void): void {
    this.listeners.get(signal)?.delete(listener)
  }
}

function writer (): { text: string; write: (chunk: string) => boolean } {
  return {
    text: '',
    write (chunk: string): boolean {
      this.text += chunk
      return true
    },
  }
}

async function createBackendProject (source = 'export function h_create(): number {\n  return 42\n}\n'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fh2-cli-service-'))
  roots.push(root)
  await mkdir(join(root, 'handlers'), { recursive: true })
  await writeFile(join(root, 'fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_cli_service',
    name: 'CLI Service',
    version: '0.1.0',
    contractsRange: '>=1.0.0 <2.0.0',
  }))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      lib: ['ES2022'],
      types: [],
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    include: ['handlers/**/*.ts'],
  }))
  await writeFile(join(root, 'handlers/create.ts'), source)
  return root
}

describe('cLI → TaskService/Application Service 标准路径', () => {
  it('capability config accepts repeated copies of one frontend ID through the real application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-cli-config-selection-'))
    roots.push(root)
    const frontendRoot = join(root, 'frontend/exp_front')
    await mkdir(join(frontendRoot, 'src'), { recursive: true })
    await writeFile(join(root, 'capabilities.json'), JSON.stringify({ name: 'Config selection', description: 'fixture' }))
    await writeFile(join(frontendRoot, 'fh2-plugin.json'), JSON.stringify({ id: 'exp_front', name: 'Frontend', version: '1.0.0', entry: './plugin.js', extensions: [] }))
    await writeFile(join(frontendRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', lib: ['ES2022'], types: [], module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src/**/*.ts'] }))
    await writeFile(join(frontendRoot, 'src/plugin.ts'), 'export const value: number = 42\n')
    // Only the coordinator is stubbed; CLI, executor, application validation and Typecheck run unchanged.
    const buildCapability = vi.spyOn(capabilityBuild, 'buildCapability').mockImplementation(async (options) => {
      expect(options.capability.frontend.map(project => project.id)).toEqual(['exp_front'])
      expect(options.frontendConfigPath).toBe(join(root, 'custom.ts'))
      await mkdir(join(frontendRoot, 'dist'), { recursive: true })
      await writeFile(join(frontendRoot, 'dist/plugin.js'), 'export const value = 42\n')
      return { ok: true, diagnostics: [] }
    })
    const args = ['--config', 'custom.ts', '--frontend', 'exp_front', '--frontend=exp_front']
    expect(parseBuildArguments(args).frontend).toEqual(['exp_front', 'exp_front'])
    const stdout = writer()
    const stderr = writer()
    expect(await runBuildCommand({ args, cwd: root, stdout, stderr, signals: new Signals() }), stderr.text).toBe(0)
    expect(stdout.text).toContain('build task started')
    expect(stdout.text).toContain('build success')
    expect(stderr.text).toBe('')
    expect(buildCapability).toHaveBeenCalledOnce()
    expect(existsSync(join(frontendRoot, 'dist/plugin.js'))).toBe(true)

    expect(await runBuildCommand({ args: [...args, '--frontend', 'exp_other'], cwd: root, stdout: writer(), stderr: writer(), signals: new Signals() })).toBe(2)
    expect(buildCapability).toHaveBeenCalledOnce()
  })

  it.each(['task', 'compatibility'] as const)('backend --config is rejected before %s execution', async (route) => {
    const root = await createBackendProject()
    const stdout = writer()
    const stderr = writer()
    const buildBackend = vi.fn(async () => {
      throw new Error('invalid options must not invoke the backend builder')
    })
    expect(await runBuildCommand({ args: ['--config', 'ignored.ts'], cwd: root, stdout, stderr, signals: new Signals(), ...(route === 'compatibility' ? { buildBackend } : {}) })).toBe(2)
    expect(stderr.text).toContain('独立后端插件不支持 --config')
    expect(stdout.text).not.toContain('build task started')
    expect(buildBackend).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'dist'))).toBe(false)
  })

  it('build：TaskService 等终态，S6 Typecheck 通过后提交 dist', { timeout: 60_000 }, async () => {
    const root = await createBackendProject()
    const stdout = writer()
    const stderr = writer()

    const code = await runBuildCommand({
      args: [],
      cwd: root,
      stdout,
      stderr,
      signals: new Signals(),
    })

    expect(code).toBe(0)
    expect(stdout.text).toContain('build task started')
    expect(stdout.text).toContain('build success')
    expect(existsSync(join(root, 'dist/plugin.json'))).toBe(true)
    expect(existsSync(join(root, 'dist/scripts/handlers.js'))).toBe(true)
    expect(stderr.text).toBe('')
  })

  it('build：Typecheck 错误阻止新产物提交并输出 TS 诊断', { timeout: 60_000 }, async () => {
    const root = await createBackendProject('export function h_create(): number {\n  return "wrong"\n}\n')
    const stdout = writer()
    const stderr = writer()

    const code = await runBuildCommand({
      args: [],
      cwd: root,
      stdout,
      stderr,
      signals: new Signals(),
    })

    expect(code).toBe(1)
    expect(stderr.text).toMatch(/TS2322 \[typecheck\]/)
    expect(existsSync(join(root, 'dist'))).toBe(false)
  })

  it('pack：TaskService/S7 生成可上传 zip，并输出 UPLOAD_READY', { timeout: 90_000 }, async () => {
    const root = await createBackendProject()
    const stdout = writer()
    const stderr = writer()

    const code = await runPackCommand({
      args: [],
      cwd: root,
      stdout,
      stderr,
      signals: new Signals(),
    })

    expect(code).toBe(0)
    expect(stdout.text).toContain('pack task started')
    expect(stdout.text).toContain('UPLOAD_READY')
    expect(existsSync(join(root, 'release'))).toBe(true)
    expect(stderr.text).toBe('')
  })
})
