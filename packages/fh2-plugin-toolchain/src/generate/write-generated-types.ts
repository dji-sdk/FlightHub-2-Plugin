// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import type { generatePluginTypes } from 'fh2-plugin-sdk/generator'
import type { PluginManifest } from 'fh2-plugin-sdk'

export interface WriteGeneratedTypesOptions {
  readonly manifest: PluginManifest;
  readonly generator: typeof generatePluginTypes;
  readonly manifestPath: string;
  readonly outDir: string;
  readonly check?: boolean;
}

export type GeneratedFileResult = {
  readonly ok: true;
  readonly status: 'written' | 'unchanged' | 'current';
  readonly outputFile: string;
} | {
  readonly ok: false;
  readonly status: 'invalid' | 'missing' | 'stale';
  readonly outputFile: string;
}

export class GeneratedTypesPathError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'GeneratedTypesPathError'
  }
}

export interface FileOperations {
  readonly close: typeof closeSync;
  readonly exists: typeof existsSync;
  readonly fsync: typeof fsyncSync;
  readonly mkdir: typeof mkdirSync;
  readonly open: typeof openSync;
  readonly read: typeof readFileSync;
  readonly rename: typeof renameSync;
  readonly unlink: typeof unlinkSync;
  readonly write: typeof writeFileSync;
}

const FILE_OPERATIONS: FileOperations = {
  close: closeSync,
  exists: existsSync,
  fsync: fsyncSync,
  mkdir: mkdirSync,
  open: openSync,
  read: readFileSync,
  rename: renameSync,
  unlink: unlinkSync,
  write: writeFileSync,
}

export function writeGeneratedTypes (
  options: WriteGeneratedTypesOptions,
): GeneratedFileResult {
  return writeGeneratedTypesWithOperations(options, FILE_OPERATIONS)
}

export function writeGeneratedTypesWithOperations (
  options: WriteGeneratedTypesOptions,
  fileOperations: FileOperations,
): GeneratedFileResult {
  const manifestPath = resolve(options.manifestPath)
  const projectRoot = dirname(manifestPath)
  const outDir = isAbsolute(options.outDir) ? resolve(options.outDir) : resolve(projectRoot, options.outDir)
  assertOutputPath(projectRoot, outDir)

  const generated = options.generator({ manifest: options.manifest, outDir })
  if (generated.fileName !== 'plugin-types.ts')
    throw new Error(`SDK Generator 返回了不支持的文件名：${generated.fileName}`)
  if (generated.source.includes('\r') || !generated.source.endsWith('\n') || generated.source.endsWith('\n\n'))
    throw new Error('SDK Generator 输出必须使用 LF 且只有一个末尾换行')

  const outputFile = join(outDir, generated.fileName)
  let currentSource: string | undefined
  try {
    currentSource = fileOperations.read(outputFile, 'utf8')
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }

  // 再生成只更新类型正文，保留既有文件的许可/版权头；不为用户新文件擅自声明权属。
  const existingHeader = currentSource?.match(/^(?:\/\/ (?:SPDX-License-Identifier:|Copyright )[^\n]*\n)+/)?.[0] ?? ''
  const source = generated.source.startsWith(existingHeader)
    ? generated.source
    : `${existingHeader}${generated.source}`

  if (currentSource === source) {
    return {
      ok: true,
      status: options.check === true ? 'current' : 'unchanged',
      outputFile,
    }
  }

  if (options.check === true) {
    return {
      ok: false,
      status: currentSource === undefined ? 'missing' : 'stale',
      outputFile,
    }
  }

  fileOperations.mkdir(outDir, { recursive: true })
  // Recheck after mkdir so an existing symlink cannot redirect the temp file
  // outside the project between lexical validation and the first write.
  assertOutputPath(projectRoot, outDir)
  const temporaryFile = join(outDir, `.${generated.fileName}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = fileOperations.open(temporaryFile, 'wx', 0o600)
    fileOperations.write(descriptor, source, 'utf8')
    fileOperations.fsync(descriptor)
    fileOperations.close(descriptor)
    descriptor = undefined
    fileOperations.rename(temporaryFile, outputFile)
  } finally {
    if (descriptor !== undefined) {
      try {
        fileOperations.close(descriptor)
      } catch {
        // Preserve the original write/close error.
      }
    }
    if (fileOperations.exists(temporaryFile)) {
      try {
        fileOperations.unlink(temporaryFile)
      } catch {
        // Preserve the original write/rename error.
      }
    }
  }

  return { ok: true, status: 'written', outputFile }
}

function assertOutputPath (projectRoot: string, outDir: string): void {
  const fromRoot = relative(projectRoot, outDir)
  if (isOutside(fromRoot))
    throw new GeneratedTypesPathError(`类型输出目录必须位于 Manifest 项目根内：${outDir}`)

  const distDir = resolve(projectRoot, 'dist')
  const fromDist = relative(distDir, outDir)
  if (fromDist === '' || !isOutside(fromDist))
    throw new GeneratedTypesPathError(`类型输出目录不能等于或位于 dist/：${outDir}`)

  const realProjectRoot = realpathWithMissingTail(projectRoot)
  const realOutDir = realpathWithMissingTail(outDir)
  if (isOutside(relative(realProjectRoot, realOutDir)))
    throw new GeneratedTypesPathError(`类型输出目录的真实路径必须位于 Manifest 项目根内：${outDir}`)

  const realDistDir = realpathWithMissingTail(distDir)
  const realFromDist = relative(realDistDir, realOutDir)
  if (realFromDist === '' || !isOutside(realFromDist))
    throw new GeneratedTypesPathError(`类型输出目录的真实路径不能等于或位于 dist/：${outDir}`)
}

function realpathWithMissingTail (input: string): string {
  let existing = resolve(input)
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...missing)
}

function isOutside (relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
}

function isNodeError (error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
