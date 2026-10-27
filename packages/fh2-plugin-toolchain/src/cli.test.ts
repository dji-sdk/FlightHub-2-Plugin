// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from 'fh2-plugin-sdk'
import { CLI_COMMANDS } from './cli-commands.js'
import { runGenerateCommand } from './commands/generate-command.js'
import { runValidateCommand } from './commands/validate-command.js'
import { GeneratedTypesPathError } from './generate/write-generated-types.js'
import type { ValidationResult } from './validate/index.js'

const manifest: PluginManifest = {
  id: 'exp_cli',
  name: 'CLI 插件',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [],
}
const validResult: ValidationResult = { ok: true, manifest, diagnostics: [], warnings: [] }
const capabilityValidResult: ValidationResult = {
  ok: true,
  manifest: { ...manifest, id: 'exp_capability_frontend' },
  diagnostics: [],
  warnings: [],
}
const invalidResult: ValidationResult = {
  ok: false,
  diagnostics: [{
    code: 'FH2_TEST_INVALID',
    phase: 'semantic',
    file: 'fh2-plugin.json',
    path: 'version',
    message: '测试错误。',
  }],
}
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('工具链 CLI', () => {
  it('保留 create/validate/generate/types/build/pack/sign/dev/preview/knowledge/serve/mcp 命令', () => {
    expect(CLI_COMMANDS.map(command => command.name)).toEqual(['create', 'validate', 'generate', 'types', 'build', 'pack', 'sign', 'dev', 'preview', 'knowledge', 'serve', 'mcp'])
  })
})

describe('validate command handler', () => {
  it.each([
    [['--manifest', 'custom.json', '--format', 'text'], 'text'],
    [['--manifest=custom.json', '--format=json'], 'json'],
  ] as const)('支持两种参数形式并输出合法结果', async (args, format) => {
    const io = capturedIo()
    const validate = vi.fn(() => validResult)
    const code = await runValidateCommand({ args, cwd: '/project', ...io, validate, checkCode: () => [] })

    expect(code).toBe(0)
    expect(validate).toHaveBeenCalledWith({ manifestPath: join('/project', 'custom.json') })
    expect(io.stderr.text).toBe('')
    expect(format === 'json' ? JSON.parse(io.stdout.text).ok : io.stdout.text).toBe(format === 'json' ? true : '✓ custom.json 校验通过\n')
  })

  it('源码一致性 warning 写入 text/json 输出但不改变退出码', async () => {
    const warning = {
      code: 'FH2_CODE_EXTENSION_NOT_CONTRIBUTED',
      phase: 'code' as const,
      file: 'src/plugin.ts',
      message: 'Manifest 声明的 extension "hello-action" 未在源码中找到 contribute 调用。No contribute call found for declared extension "hello-action".',
    }
    for (const format of ['text', 'json']) {
      const io = capturedIo()
      const code = await runValidateCommand({
        args: ['--format', format],
        cwd: '/project',
        ...io,
        validate: () => validResult,
        checkCode: () => [warning],
      })

      expect(code).toBe(0)
      expect(io.stderr.text).toBe('')
      if (format === 'json') {
        const parsed = JSON.parse(io.stdout.text) as { ok: boolean; warnings: typeof warning[] }
        expect(parsed.ok).toBe(true)
        expect(parsed.warnings).toEqual([warning])
      } else {
        expect(io.stdout.text).toContain('[warning] FH2_CODE_EXTENSION_NOT_CONTRIBUTED')
        expect(io.stdout.text).toContain('No contribute call found')
      }
    }
  })

  it('生成类型未被消费时作为阻断错误退出', async () => {
    const io = capturedIo()
    const diagnostic = {
      code: 'FH2_CODE_GENERATED_TYPES_UNUSED',
      phase: 'code' as const,
      file: 'src/plugin.ts',
      message: '插件声明了 Extension，但源码未导入 generated/plugin-types。',
    }
    const code = await runValidateCommand({
      args: [],
      cwd: '/project',
      ...io,
      validate: () => validResult,
      checkCode: () => [diagnostic],
    })

    expect(code).toBe(1)
    expect(io.stdout.text).toContain('FH2_CODE_GENERATED_TYPES_UNUSED')
  })

  it('config 参数交给 Build descriptor resolver 解析自定义入口', async () => {
    const io = capturedIo()
    const resolveDescriptor = vi.fn(async () => ({
      manifestPath: '/project/fh2-plugin.json',
      projectRoot: '/project',
      pluginEntry: '/project/custom/entry.ts',
      typesOutDir: '/project/src/generated',
      distRoot: '/project/dist',
    }))
    const code = await runValidateCommand({
      args: [
        '--manifest',
        './plugins/demo/fh2-plugin.json',
        '--config',
        './configs/rsbuild.preview.ts',
      ],
      cwd: '/project',
      ...io,
      validate: () => validResult,
      resolveDescriptor,
    })
    expect(code).toBe(0)
    expect(resolveDescriptor).toHaveBeenCalledWith({
      cwd: '/project/plugins/demo',
      configPath: '/project/configs/rsbuild.preview.ts',
      expectedManifestPath: '/project/plugins/demo/fh2-plugin.json',
    })
  })

  it('非法 Manifest 的 text/json 都只写 stdout 并退出 1', async () => {
    for (const format of ['text', 'json']) {
      const io = capturedIo()
      const code = await runValidateCommand({
        args: ['--format', format],
        cwd: '/project',
        ...io,
        validate: () => invalidResult,
      })
      expect(code).toBe(1)
      expect(io.stdout.text).toContain(format === 'json' ? '"ok": false' : 'FH2_TEST_INVALID')
      expect(io.stderr.text).toBe('')
    }
  })

  it('坏 JSON 的上下文发现错误仍输出既有 JSON 信封与真实原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-validate-json-'))
    temporaryRoots.push(root)
    await writeFile(join(root, 'fh2-plugin.json'), '{"id":}')
    const io = capturedIo()

    expect(await runValidateCommand({ args: ['--format', 'json'], cwd: root, ...io })).toBe(1)
    expect(JSON.parse(io.stdout.text)).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostics: [{
        code: 'FH2_CONTEXT_NOT_FOUND',
        phase: 'parse',
        file: 'fh2-plugin.json',
        message: expect.stringContaining('ValueExpected'),
      }],
      warnings: [],
    })
    expect(io.stderr.text).toContain('FH2_CONTEXT_NOT_FOUND')
  })

  it('无标志文件的 JSON 校验保留 Manifest 读取失败诊断', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fh2-validate-missing-'))
    temporaryRoots.push(root)
    const io = capturedIo()

    expect(await runValidateCommand({ args: ['--format=json'], cwd: root, ...io })).toBe(1)
    expect(JSON.parse(io.stdout.text)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      diagnostics: [{ code: 'FH2_MANIFEST_READ_FAILED', message: expect.stringContaining('ENOENT') }],
      warnings: [],
    })
    expect(io.stdout.text).not.toContain('位置提示')
    expect(io.stderr.text).toContain('位置提示')
  })

  it('已解析 JSON format 后的内部异常输出失败信封并保持退出 3', async () => {
    const io = capturedIo()
    expect(await runValidateCommand({
      args: ['--manifest', 'custom.json', '--format=json'],
      cwd: '/project',
      ...io,
      validate: () => {
        throw new Error('disk read failed')
      },
    })).toBe(3)
    expect(JSON.parse(io.stdout.text)).toEqual({
      schemaVersion: 1,
      ok: false,
      diagnostics: [{ code: 'FH2_VALIDATE_INTERNAL', phase: 'parse', file: '.', message: 'disk read failed' }],
      warnings: [],
    })
    expect(io.stderr.text).toContain('内部错误：disk read failed')
  })

  it.each([
    ['未知', ['--unknown']],
    ['位置参数', ['manifest.json']],
    ['缺值', ['--manifest']],
    ['重复', ['--format=text', '--format', 'json']],
    ['非法 format', ['--format=yaml']],
    ['JSON 后的未知参数', ['--format=json', '--unknown']],
  ])('%s参数错误写 stderr 并退出 2', async (_name, args) => {
    const io = capturedIo()
    expect(await runValidateCommand({ args, cwd: '/project', ...io, validate: () => validResult })).toBe(2)
    expect(io.stdout.text).toBe('')
    expect(io.stderr.text).toContain('用法：fh2-plugin validate')
  })

  it('help 不读取 Manifest', async () => {
    const io = capturedIo()
    const validate = vi.fn(() => validResult)
    expect(await runValidateCommand({ args: ['--help'], cwd: '/project', ...io, validate })).toBe(0)
    expect(validate).not.toHaveBeenCalled()
    expect(io.stdout.text).toContain('用法：fh2-plugin validate')
  })

  it('未预期异常映射退出 3', async () => {
    const io = capturedIo()
    expect(await runValidateCommand({
      args: [],
      cwd: '/project',
      ...io,
      validate: () => {
        throw new Error('boom')
      },
    })).toBe(3)
    expect(io.stderr.text).toContain('内部错误：boom')
  })

  it('在 Capability 根聚合前后端校验', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()

    const code = await runValidateCommand({
      args: [],
      cwd: root,
      ...io,
      validate: () => capabilityValidResult,
    })

    expect(code).toBe(0)
    expect(io.stdout.text).toContain('[capability exp_capability]')
    expect(io.stdout.text).toContain('[frontend exp_capability_frontend] validate success')
    expect(io.stdout.text).toContain('[backend exp_capability_backend] validate success')
  })

  it('capability 根的 --config 必须显式指定前端 Manifest', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()

    const code = await runValidateCommand({
      args: ['--config', 'rsbuild.config.ts'],
      cwd: root,
      ...io,
      validate: () => validResult,
    })

    expect(code).toBe(2)
    expect(io.stderr.text).toContain('必须同时用 --manifest')
  })

  it('后端插件根的 --config 直接报参数错误，不误入前端 Manifest 校验', async () => {
    const backendRoot = await mkdtemp(join(tmpdir(), 'fh2-backend-config-'))
    temporaryRoots.push(backendRoot)
    await writeFile(join(backendRoot, 'fh2-plugin.json'), JSON.stringify({
      pluginId: 'exp_backend_config',
      name: 'Backend Config',
      version: '0.1.0',
      entities: [],
    }))
    const io = capturedIo()

    const code = await runValidateCommand({
      args: ['--config', 'rsbuild.config.ts'],
      cwd: backendRoot,
      ...io,
      validate: () => validResult,
    })

    expect(code).toBe(2)
    expect(io.stdout.text).toBe('')
    expect(io.stderr.text).toContain('后端插件校验不支持 --config')
  })

  it('显式 --manifest 不读取无关的 Capability 元数据', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()
    await writeFile(join(root, 'capabilities.json'), '{}')

    const code = await runValidateCommand({
      args: ['--manifest', 'frontend/exp_capability_frontend/fh2-plugin.json'],
      cwd: root,
      ...io,
      validate: () => validResult,
      checkCode: () => [],
    })

    expect(code).toBe(0)
    expect(io.stderr.text).toBe('')
  })
})

describe('generate command handler', () => {
  it.each([
    ['分离参数', ['--manifest', 'plugin/fh2-plugin.json', '--out', 'types']],
    ['等号参数', ['--manifest=plugin/fh2-plugin.json', '--out=types']],
  ])('%s以 Manifest 根解析 out 并写入已验证快照', (_name, args) => {
    const io = capturedIo()
    const writeTypes = vi.fn(() => ({
      ok: true as const,
      status: 'written' as const,
      outputFile: '/cwd/plugin/types/plugin-types.ts',
    }))
    const code = runGenerateCommand({
      args,
      cwd: '/cwd',
      ...io,
      validate: () => validResult,
      writeTypes,
    })

    expect(code).toBe(0)
    expect(writeTypes).toHaveBeenCalledWith(expect.objectContaining({
      manifest,
      manifestPath: '/cwd/plugin/fh2-plugin.json',
      outDir: '/cwd/plugin/types',
    }))
    expect(io.stdout.text).toContain('./types/plugin-types.ts')
    expect(io.stderr.text).toBe('')
  })

  it('manifest 校验失败时不调用 Writer 并退出 1', () => {
    const io = capturedIo()
    const writeTypes = vi.fn()
    expect(runGenerateCommand({
      args: [],
      cwd: '/cwd',
      ...io,
      validate: () => invalidResult,
      writeTypes,
    })).toBe(1)
    expect(writeTypes).not.toHaveBeenCalled()
    expect(io.stdout.text).toContain('FH2_TEST_INVALID')
  })

  it.each([
    ['missing', '缺失'],
    ['stale', '已过期'],
  ] as const)('check %s 不写文件并退出 1', (status, message) => {
    const io = capturedIo()
    const code = runGenerateCommand({
      args: ['--check'],
      cwd: '/cwd',
      ...io,
      validate: () => validResult,
      writeTypes: () => ({ ok: false, status, outputFile: '/cwd/src/generated/plugin-types.ts' }),
    })
    expect(code).toBe(1)
    expect(io.stdout.text).toContain(message)
    expect(io.stdout.text).toContain('fh2-plugin generate')
  })

  it.each([
    ['未知', ['--format', 'json']],
    ['位置参数', ['types']],
    ['缺值', ['--out']],
    ['重复', ['--check', '--check']],
    ['boolean 带值', ['--check=true']],
  ])('%s参数错误退出 2', (_name, args) => {
    const io = capturedIo()
    expect(runGenerateCommand({ args, cwd: '/cwd', ...io, validate: () => validResult })).toBe(2)
    expect(io.stdout.text).toBe('')
    expect(io.stderr.text).toContain('用法：fh2-plugin generate')
  })

  it('输出路径错误退出 2，文件系统错误退出 3', () => {
    const pathIo = capturedIo()
    expect(runGenerateCommand({
      args: [],
      cwd: '/cwd',
      ...pathIo,
      validate: () => validResult,
      writeTypes: () => {
        throw new GeneratedTypesPathError('outside')
      },
    })).toBe(2)

    const fsIo = capturedIo()
    expect(runGenerateCommand({
      args: [],
      cwd: '/cwd',
      ...fsIo,
      validate: () => validResult,
      writeTypes: () => {
        throw new Error('disk full')
      },
    })).toBe(3)
    expect(fsIo.stderr.text).toContain('disk full')
  })

  it('help 不校验 Manifest', () => {
    const io = capturedIo()
    const validate = vi.fn(() => validResult)
    expect(runGenerateCommand({ args: ['--help'], cwd: '/cwd', ...io, validate })).toBe(0)
    expect(validate).not.toHaveBeenCalled()
  })

  it('在 Capability 根只为所有前端插件生成类型', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()
    const writeTypes = vi.fn(() => ({
      ok: true as const,
      status: 'written' as const,
      outputFile: join(root, 'frontend/exp_capability_frontend/src/generated/plugin-types.ts'),
    }))

    const code = runGenerateCommand({
      args: [],
      cwd: root,
      ...io,
      validate: () => validResult,
      writeTypes,
    })

    expect(code).toBe(0)
    expect(writeTypes).toHaveBeenCalledTimes(1)
    expect(writeTypes).toHaveBeenCalledWith(expect.objectContaining({
      manifestPath: join(root, 'frontend/exp_capability_frontend/fh2-plugin.json'),
    }))
    expect(io.stdout.text).toContain('[frontend exp_capability_frontend]')
  })

  it('capability 根的 --out 必须显式指定前端 Manifest', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()

    const code = runGenerateCommand({
      args: ['--out', 'types'],
      cwd: root,
      ...io,
      validate: () => validResult,
    })

    expect(code).toBe(2)
    expect(io.stderr.text).toContain('必须同时用 --manifest')
  })

  it('显式 --manifest 生成类型时不读取无关的 Capability 元数据', async () => {
    const root = await createCapabilityFixture()
    const io = capturedIo()
    await writeFile(join(root, 'capabilities.json'), '{}')

    const code = runGenerateCommand({
      args: ['--manifest', 'frontend/exp_capability_frontend/fh2-plugin.json'],
      cwd: root,
      ...io,
      validate: () => validResult,
      writeTypes: () => ({
        ok: true,
        status: 'written',
        outputFile: join(root, 'frontend/exp_capability_frontend/src/generated/plugin-types.ts'),
      }),
    })

    expect(code).toBe(0)
    expect(io.stderr.text).toBe('')
  })
})

async function createCapabilityFixture (): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'fh2-capability-command-'))
  const root = join(parent, 'exp_capability')
  temporaryRoots.push(parent)
  await mkdir(join(root, 'frontend/exp_capability_frontend'), { recursive: true })
  await mkdir(join(root, 'backend/exp_capability_backend'), { recursive: true })
  await writeFile(join(root, 'capabilities.json'), JSON.stringify({
    name: '能力测试',
    description: '命令入口测试',
  }))
  await writeFile(join(root, 'frontend/exp_capability_frontend/fh2-plugin.json'), JSON.stringify({
    id: 'exp_capability_frontend',
  }))
  await writeFile(join(root, 'backend/exp_capability_backend/fh2-plugin.json'), JSON.stringify({
    pluginId: 'exp_capability_backend',
    name: '后端测试',
    version: '0.1.0',
  }))
  return root
}

function capturedIo (): {
  readonly stdout: CaptureWriter;
  readonly stderr: CaptureWriter;
} {
  return { stdout: new CaptureWriter(), stderr: new CaptureWriter() }
}

class CaptureWriter {
  text = ''

  write (chunk: string): boolean {
    this.text += chunk
    return true
  }
}
