// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { generatePluginTypes as generateSdkPluginTypes } from 'fh2-plugin-sdk/generator'
import { GENERATED_BACKEND_TYPE_FILES, syncPluginTypes } from '../../backend/typegen/sync.js'
import { acquireOperationLock } from '../tasks/operation-lock.js'
import type { Diagnostic } from '../../contracts/index.js'
import { generatePluginTypes as generateBackendPluginTypes } from '../../backend/typegen/plugin-types.js'
import { tryDiscoverCommandContext } from '../../capability/discovery.js'
import { GeneratedTypesPathError, writeGeneratedTypes } from '../../generate/write-generated-types.js'
import { validateSourceManifest } from '../../validate/index.js'
import { PROJECT_PATHS } from '../../project-policy.js'

/**
 * S3：Generate Application Service。
 *
 * 复用前端 generator（plugin-types.ts）与后端 types 生成器，与 CLI 产出完全一致：
 * - `check: true` 只检查文件是否最新，不写文件；
 * - 普通生成幂等（内容未变化不写）；
 * - Capability 根同时重生成前端 src/generated/plugin-types.ts 与后端 types/；
 * - 锁冲突/路径非法以结构化诊断返回。
 */
export interface GenerateProjectResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** 生成的文件（相对 root 的 POSIX 路径）。 */
  readonly files: readonly string[];
  /** check 模式下发现的过期/缺失文件。 */
  readonly outdated: readonly string[];
}

export interface GenerateProjectOptions {
  readonly check?: boolean;
  readonly operationLockHeld?: boolean;
  /** CLI-resolved output default; relative paths are based on each frontend Manifest root. */
  readonly frontendOutDir?: string;
}

export function generateProject (rawRoot: string, options: GenerateProjectOptions = {}): GenerateProjectResult {
  const release = options.check || options.operationLockHeld ? undefined : acquireOperationLock(rawRoot)
  try {
    return generateProjectUnlocked(rawRoot, options)
  } finally {
    release?.()
  }
}

function generateProjectUnlocked (rawRoot: string, options: GenerateProjectOptions): GenerateProjectResult {
  const root = resolve(rawRoot)
  const check = options.check === true
  const frontendOutDir = options.frontendOutDir ?? PROJECT_PATHS.generatedTypes
  const context = tryDiscoverCommandContext(root)
  const diagnostics: Diagnostic[] = []
  const files: string[] = []
  const outdated: string[] = []

  if (context?.kind === 'capability-project') {
    for (const frontend of context.frontend) {
      const result = generateFrontend(frontend.root, frontend.manifestPath, frontendOutDir, check, diagnostics, files, outdated)
      if (!result) return { ok: false, diagnostics, files, outdated }
    }
    for (const backend of context.backend) {
      generateBackend(backend.root, check, diagnostics, files, outdated)
    }
    return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), diagnostics, files, outdated }
  }
  if (context?.kind === 'backend-plugin') {
    generateBackend(context.root, check, diagnostics, files, outdated)
    return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), diagnostics, files, outdated }
  }
  if (context?.kind === 'industry-capability-workspace') {
    for (const capability of context.capabilities) {
      for (const frontend of capability.frontend) {
        const result = generateFrontend(frontend.root, frontend.manifestPath, frontendOutDir, check, diagnostics, files, outdated)
        if (!result) return { ok: false, diagnostics, files, outdated }
      }
      for (const backend of capability.backend) {
        generateBackend(backend.root, check, diagnostics, files, outdated)
      }
    }
    return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), diagnostics, files, outdated }
  }
  if (context?.kind === 'frontend-plugin') {
    const result = generateFrontend(context.root, context.manifestPath, frontendOutDir, check, diagnostics, files, outdated)
    if (!result) return { ok: false, diagnostics, files, outdated }
    return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), diagnostics, files, outdated }
  }
  return {
    ok: false,
    diagnostics: [{
      code: 'FH2_PROJECT_NOT_RECOGNIZED',
      phase: 'semantic',
      file: '.',
      message: '目标目录不是 Capability、前端插件或后端插件，无法生成类型。Target is not a generatable project.',
      severity: 'error',
    }],
    files,
    outdated,
  }
}

function generateFrontend (
  projectRoot: string,
  manifestPath: string,
  outDir: string,
  check: boolean,
  diagnostics: Diagnostic[],
  files: string[],
  outdated: string[],
): boolean {
  const validation = validateSourceManifest({ manifestPath })
  if (!validation.ok) {
    for (const item of validation.diagnostics) {
      diagnostics.push({
        code: item.code,
        phase: item.phase,
        file: relativeDisplay(projectRoot, item.file ?? manifestPath),
        message: item.message,
        severity: 'error',
      })
    }
    return false
  }
  try {
    const result = writeGeneratedTypes({
      manifest: validation.manifest,
      generator: generateSdkPluginTypes,
      manifestPath,
      outDir: resolve(projectRoot, outDir),
      check,
    })
    const outputFile = relativeDisplay(projectRoot, result.outputFile)
    if (result.ok) {
      files.push(outputFile)
      return true
    }
    outdated.push(outputFile)
    diagnostics.push({
      code: 'FH2_GENERATE_OUTDATED',
      phase: 'code',
      file: outputFile,
      message: `类型文件${result.status === 'missing' ? '缺失' : '已过期'}：${outputFile}`,
      severity: 'error',
    })
    return false
  } catch (error) {
    diagnostics.push({
      code: error instanceof GeneratedTypesPathError ? 'FH2_GENERATE_PATH_INVALID' : 'FH2_GENERATE_FAILED',
      phase: 'code',
      file: '.',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
    })
    return false
  }
}

function generateBackend (
  backendRoot: string,
  check: boolean,
  diagnostics: Diagnostic[],
  files: string[],
  outdated: string[],
): void {
  try {
    const result = generateBackendPluginTypes(backendRoot)
    const typesDir = join(backendRoot, 'types')
    if (check) {
      let ok = true
      if (!existsSync(typesDir)) {
        outdated.push('types/')
        ok = false
      } else {
        for (const [file, source] of result.files) {
          const onDisk = existsSync(join(typesDir, file)) ? readFileSync(join(typesDir, file), 'utf8') : undefined
          if (onDisk !== source) {
            outdated.push(`types/${file}`)
            ok = false
          }
        }
      }
      if (existsSync(typesDir)) {
        for (const file of GENERATED_BACKEND_TYPE_FILES) {
          if (!result.files.has(file) && existsSync(join(typesDir, file))) {
            outdated.push(`types/${file}`)
            ok = false
          }
        }
      }
      if (!ok) {
        diagnostics.push({
          code: 'FH2_GENERATE_OUTDATED',
          phase: 'code',
          file: 'types/',
          message: '后端 types/ 不是最新。Backend types/ is outdated.',
          severity: 'error',
        })
      }
      return
    }
    syncPluginTypes(backendRoot)
    for (const file of result.files.keys()) {
      files.push(`types/${file}`)
    }
  } catch (error) {
    diagnostics.push({
      code: 'FH2_GENERATE_FAILED',
      phase: 'code',
      file: 'types/',
      message: error instanceof Error ? error.message : String(error),
      severity: 'error',
    })
  }
}

function relativeDisplay (projectRoot: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(projectRoot, file)
  const fromRoot = relative(projectRoot, absolute)
  return fromRoot === '' || fromRoot.startsWith('..') ? file.split(sep).join('/') : fromRoot.split(sep).join('/')
}

export { basename as _generateBasename, readdirSync as _readdirSync, dirname as _dirname }
