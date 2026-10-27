// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'
import {
  GeneratedTypesPathError,
  writeGeneratedTypes,
  writeGeneratedTypesWithOperations,
} from './write-generated-types.js'

const manifest: PluginManifest = {
  id: 'exp_generate',
  name: '生成插件',
  version: '1.0.0',
  entry: './plugin.js',
  extensions: [{ id: 'hello-action', point: 'cockpit.ui.toolbar-actions' }],
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('writeGeneratedTypes', () => {
  it('从已验证快照首次创建文件，不重读 Manifest', () => {
    const projectRoot = temporaryProject()
    const result = generate(projectRoot)

    expect(result).toMatchObject({ ok: true, status: 'written' })
    expect(readFileSync(join(projectRoot, 'src/generated/plugin-types.ts'), 'utf8'))
      .toBe(generatePluginTypes({ manifest, outDir: join(projectRoot, 'src/generated') }).source)
  })

  it('创建不存在的输出目录并保留其中其他文件', () => {
    const projectRoot = temporaryProject()
    const outDir = join(projectRoot, 'custom/generated')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'keep.txt'), 'keep', 'utf8')

    generate(projectRoot, { outDir })
    expect(readFileSync(join(outDir, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('内容相同时不写文件且保持 mtime', () => {
    const projectRoot = temporaryProject()
    const first = generate(projectRoot)
    if (!first.ok) throw new Error('首次生成失败')
    const before = statSync(first.outputFile, { bigint: true }).mtimeNs
    const second = generate(projectRoot)

    expect(second).toMatchObject({ ok: true, status: 'unchanged' })
    expect(statSync(first.outputFile, { bigint: true }).mtimeNs).toBe(before)
  })

  it('内容变化时原子替换目标', () => {
    const projectRoot = temporaryProject()
    generate(projectRoot)
    const nextManifest = { ...manifest, version: '1.0.1' }
    const result = generate(projectRoot, { manifest: nextManifest })

    expect(result).toMatchObject({ ok: true, status: 'written' })
    expect(readFileSync(result.outputFile, 'utf8')).toContain('@1.0.1')
  })

  it('再生成及 check 保留已有许可版权头，不因头部把当前文件判为 stale', () => {
    const projectRoot = temporaryProject()
    const first = generate(projectRoot)
    const header = '// SPDX-License-Identifier: Apache-2.0\n// Copyright (c) 2026 Example Authors\n'
    writeFileSync(first.outputFile, `${header}${readFileSync(first.outputFile, 'utf8')}`, 'utf8')

    expect(generate(projectRoot, { check: true })).toMatchObject({ ok: true, status: 'current' })
    expect(generate(projectRoot)).toMatchObject({ ok: true, status: 'unchanged' })
    expect(generate(projectRoot, { manifest: { ...manifest, version: '1.0.1' }, check: true }))
      .toMatchObject({ ok: false, status: 'stale' })
    generate(projectRoot, { manifest: { ...manifest, version: '1.0.1' } })
    const text = readFileSync(first.outputFile, 'utf8')
    expect(text.startsWith(header)).toBe(true)
    expect(text).toContain('@1.0.1')
    expect(text.match(/SPDX-License-Identifier:/g)).toHaveLength(1)
  })

  it('首次生成不擅自给用户文件增加公司版权声明', () => {
    const projectRoot = temporaryProject()
    const result = generate(projectRoot)
    expect(readFileSync(result.outputFile, 'utf8')).not.toContain('Copyright')
  })

  it.each([
    ['项目根外', (root: string) => resolve(root, '..', 'outside')],
    ['dist 本身', (root: string) => join(root, 'dist')],
    ['dist 子目录', (root: string) => join(root, 'dist/generated')],
  ])('拒绝%s的输出路径', (_name, outputPath) => {
    const projectRoot = temporaryProject()
    expect(() => generate(projectRoot, { outDir: outputPath(projectRoot) })).toThrow(GeneratedTypesPathError)
  })

  it('允许项目根内名称以点点或 dist 为前缀的普通目录', () => {
    const projectRoot = temporaryProject()
    expect(generate(projectRoot, { outDir: join(projectRoot, '..generated') })).toMatchObject({ ok: true })
    expect(generate(projectRoot, { outDir: join(projectRoot, 'dist-old/generated') })).toMatchObject({ ok: true })
  })

  it('拒绝通过目录 symlink 把输出写到项目根外', () => {
    const projectRoot = temporaryProject()
    const outsideRoot = temporaryProject()
    // Windows 用 junction（目录链接无需开发者模式），realpath 复核语义一致
    symlinkSync(outsideRoot, join(projectRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => generate(projectRoot, { outDir: join(projectRoot, 'linked/generated') }))
      .toThrow(/真实路径必须位于/)
    expect(existsSync(join(outsideRoot, 'generated'))).toBe(false)
  })

  it('check 最新时不写文件、不改 mtime', () => {
    const projectRoot = temporaryProject()
    const written = generate(projectRoot)
    if (!written.ok) throw new Error('首次生成失败')
    const before = statSync(written.outputFile, { bigint: true }).mtimeNs

    expect(generate(projectRoot, { check: true })).toMatchObject({ ok: true, status: 'current' })
    expect(statSync(written.outputFile, { bigint: true }).mtimeNs).toBe(before)
  })

  it('check 缺失时不创建输出目录', () => {
    const projectRoot = temporaryProject()
    const outDir = join(projectRoot, 'missing/generated')
    expect(generate(projectRoot, { outDir, check: true })).toMatchObject({ ok: false, status: 'missing' })
    expect(existsSync(outDir)).toBe(false)
  })

  it('check 过期时不修改目标', () => {
    const projectRoot = temporaryProject()
    const outDir = join(projectRoot, 'src/generated')
    mkdirSync(outDir, { recursive: true })
    const outputFile = join(outDir, 'plugin-types.ts')
    writeFileSync(outputFile, 'stale\n', 'utf8')
    const before = statSync(outputFile, { bigint: true }).mtimeNs

    expect(generate(projectRoot, { check: true })).toMatchObject({ ok: false, status: 'stale' })
    expect(readFileSync(outputFile, 'utf8')).toBe('stale\n')
    expect(statSync(outputFile, { bigint: true }).mtimeNs).toBe(before)
  })

  it('check 目标不可读时作为文件系统错误抛出且不写入', () => {
    const projectRoot = temporaryProject()
    const operations = fileOperations({
      read: () => {
        const error = new Error('permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
    })
    expect(() => generate(projectRoot, { check: true, operations })).toThrow('permission denied')
    expect(existsSync(join(projectRoot, 'src/generated'))).toBe(false)
  })

  it.each(['write', 'close', 'rename'] as const)('%s 失败时保留旧文件并清理临时文件', (failure) => {
    const projectRoot = temporaryProject()
    const outDir = join(projectRoot, 'src/generated')
    mkdirSync(outDir, { recursive: true })
    const outputFile = join(outDir, 'plugin-types.ts')
    writeFileSync(outputFile, 'old\n', 'utf8')
    let closeCalls = 0
    const operations = fileOperations({
      ...(failure === 'write'
        ? {
            write: () => {
              throw new Error('write failed')
            },
          }
        : {}),
      ...(failure === 'close'
        ? {
            close: (descriptor: number) => {
              closeCalls += 1
              if (closeCalls === 1) throw new Error('close failed')
              closeSync(descriptor)
            },
          }
        : {}),
      ...(failure === 'rename'
        ? {
            rename: () => {
              throw new Error('rename failed')
            },
          }
        : {}),
    })

    expect(() => generate(projectRoot, { operations })).toThrow(`${failure} failed`)
    expect(readFileSync(outputFile, 'utf8')).toBe('old\n')
    expect(readdirSync(outDir).filter(file => file.endsWith('.tmp'))).toEqual([])
  })

  it('重复生成的最终内容完整且确定', () => {
    const projectRoot = temporaryProject()
    const results = Array.from({ length: 10 }, () => generate(projectRoot))
    expect(results.every(result => result.ok)).toBe(true)
    const expected = generatePluginTypes({ manifest, outDir: join(projectRoot, 'src/generated') }).source
    expect(readFileSync(join(projectRoot, 'src/generated/plugin-types.ts'), 'utf8')).toBe(expected)
  })

  it('两个交错写入使用独立临时文件并得到相同完整结果', () => {
    const projectRoot = temporaryProject()
    let nested = false
    const operations = fileOperations({
      open: (path, flags, mode) => {
        if (!nested) {
          nested = true
          generate(projectRoot)
        }
        return openSync(path, flags, mode)
      },
    })

    expect(generate(projectRoot, { operations })).toMatchObject({ ok: true, status: 'written' })
    const expected = generatePluginTypes({ manifest, outDir: join(projectRoot, 'src/generated') }).source
    expect(readFileSync(join(projectRoot, 'src/generated/plugin-types.ts'), 'utf8')).toBe(expected)
    expect(readdirSync(join(projectRoot, 'src/generated')).filter(file => file.endsWith('.tmp'))).toEqual([])
  })

  it('拒绝违反文件名或换行 invariant 的 SDK Generator 输出', () => {
    const projectRoot = temporaryProject()
    const base = {
      manifest,
      manifestPath: join(projectRoot, 'missing-manifest.json'),
      outDir: './src/generated',
    }
    expect(() => writeGeneratedTypes({
      ...base,
      generator: (() => ({ fileName: 'other.ts', source: 'x\n' })) as unknown as typeof generatePluginTypes,
    })).toThrow('不支持的文件名')
    expect(() => writeGeneratedTypes({
      ...base,
      generator: (() => ({ fileName: 'plugin-types.ts', source: 'x\r\n' })) as typeof generatePluginTypes,
    })).toThrow('必须使用 LF')
  })
})

function temporaryProject (): string {
  const directory = mkdtempSync(join(tmpdir(), 'fh2-generate-'))
  temporaryDirectories.push(directory)
  return directory
}

function generate (
  projectRoot: string,
  overrides: {
    readonly manifest?: PluginManifest;
    readonly outDir?: string;
    readonly check?: boolean;
    readonly operations?: Parameters<typeof writeGeneratedTypesWithOperations>[1];
  } = {},
): ReturnType<typeof writeGeneratedTypes> {
  const options = {
    manifest: overrides.manifest ?? manifest,
    generator: generatePluginTypes,
    manifestPath: join(projectRoot, 'manifest-does-not-need-to-exist.json'),
    outDir: overrides.outDir ?? './src/generated',
    ...(overrides.check === undefined ? {} : { check: overrides.check }),
  }
  return overrides.operations === undefined
    ? writeGeneratedTypes(options)
    : writeGeneratedTypesWithOperations(options, overrides.operations)
}

function fileOperations (
  overrides: Partial<Parameters<typeof writeGeneratedTypesWithOperations>[1]>,
): Parameters<typeof writeGeneratedTypesWithOperations>[1] {
  return {
    close: closeSync,
    exists: existsSync,
    fsync: fsyncSync,
    mkdir: mkdirSync,
    open: openSync,
    read: readFileSync,
    rename: renameSync,
    unlink: unlinkSync,
    write: writeFileSync,
    ...overrides,
  }
}
