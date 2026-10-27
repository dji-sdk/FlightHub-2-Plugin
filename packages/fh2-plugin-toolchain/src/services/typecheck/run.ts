// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import type { Diagnostic, DiagnosticSeverity } from '../../contracts/index.js'

/**
 * B2a/B2b：Typecheck Runner（实施计划 §3.4）。
 *
 * - 前端：含 `.vue` 的工程用 vue-tsc，普通 TS 用项目 tsconfig 的 tsc；一律 noEmit，
 *   不向 dist 写 tsc 输出；
 * - 后端：使用真实 tsconfig 与生成类型（`types/`）；类型错误阻止新产物提交（S6 消费）；
 * - 缺少必要配置/工具时返回明确诊断，不标 typechecked（`ok:false` 且诊断可读）；
 * - Diagnostic 统一 1-based 行列（tsc API 已是 1-based；vue-tsc stdout 解析保持一致）。
 */

export interface TypecheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** 是否真实执行了类型检查（缺配置/缺工具时 false，不伪造通过）。 */
  readonly executed: boolean;
}

const TSC_LINE_PATTERN = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/
const TSC_GLOBAL_LINE_PATTERN = /^(error|warning)\s+(TS\d+):\s+(.*)$/

/** B2a：前端 Typecheck。projectRoot 为插件根，tsconfigPath 必须存在。 */
export async function typecheckFrontendProject (options: {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly hasVue: boolean;
  readonly abortSignal?: AbortSignal;
}): Promise<TypecheckResult> {
  const { projectRoot, tsconfigPath, hasVue, abortSignal } = options
  if (abortSignal?.aborted) throw new Error('Typecheck 已被取消。Typecheck was aborted.')
  if (!existsSync(tsconfigPath)) {
    return missingConfigResult(projectRoot, tsconfigPath, '前端')
  }
  if (hasVue) {
    return await runVueTsc(projectRoot, tsconfigPath, abortSignal)
  }
  return runTscProgram(projectRoot, tsconfigPath)
}

/** B2b：后端 Typecheck。 */
export async function typecheckBackendProject (options: {
  readonly projectRoot: string;
  readonly tsconfigPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<TypecheckResult> {
  const { projectRoot, tsconfigPath, abortSignal } = options
  if (abortSignal?.aborted) throw new Error('Typecheck 已被取消。Typecheck was aborted.')
  if (!existsSync(tsconfigPath)) {
    return missingConfigResult(projectRoot, tsconfigPath, '后端')
  }
  return runTscProgram(projectRoot, tsconfigPath)
}

function missingConfigResult (projectRoot: string, tsconfigPath: string, side: '前端' | '后端'): TypecheckResult {
  return {
    ok: false,
    executed: false,
    diagnostics: [{
      code: 'FH2_TYPECHECK_CONFIG_MISSING',
      phase: 'typecheck',
      file: relativeDisplay(projectRoot, tsconfigPath),
      message: `${side}工程缺少 tsconfig.json，无法执行 Typecheck。${side} project is missing tsconfig.json; typecheck was not executed.`,
      hint: tsconfigPath,
      severity: 'error',
    }],
  }
}

/** 程序化 tsc：结构化诊断，无 stdout 解析。 */
function runTscProgram (projectRoot: string, tsconfigPath: string): TypecheckResult {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    return {
      ok: false,
      executed: false,
      diagnostics: [fromTsDiagnostic(configFile.error, projectRoot)],
    }
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigPath))
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      executed: false,
      diagnostics: parsed.errors.map(diagnostic => fromTsDiagnostic(diagnostic, projectRoot)),
    }
  }
  // noEmit：绝不向 dist / 源码目录写 tsc 产物。
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(diagnostic => fromTsDiagnostic(diagnostic, projectRoot))
  return { ok: diagnostics.every(diagnostic => diagnostic.severity !== 'error'), executed: true, diagnostics }
}

function fromTsDiagnostic (diagnostic: ts.Diagnostic, projectRoot: string): Diagnostic {
  const file = diagnostic.file === undefined
    ? '.'
    : relativeDisplay(projectRoot, diagnostic.file.fileName)
  let line: number | undefined
  let column: number | undefined
  if (diagnostic.file !== undefined && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    line = position.line + 1
    column = position.character + 1
  }
  const severity: DiagnosticSeverity = diagnostic.category === ts.DiagnosticCategory.Error
    ? 'error'
    : diagnostic.category === ts.DiagnosticCategory.Warning
      ? 'warning'
      : 'info'
  return {
    code: `TS${diagnostic.code}`,
    phase: 'typecheck',
    file,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    severity,
  }
}

/** vue-tsc 子进程：stdout/stderr 逐行解析为结构化诊断。 */
async function runVueTsc (projectRoot: string, tsconfigPath: string, abortSignal?: AbortSignal): Promise<TypecheckResult> {
  const vueTscBin = resolveVueTscBin()
  if (vueTscBin === null) {
    return {
      ok: false,
      executed: false,
      diagnostics: [{
        code: 'FH2_TYPECHECK_TOOL_MISSING',
        phase: 'typecheck',
        file: relativeDisplay(projectRoot, tsconfigPath),
        message: 'vue-tsc 不可用，含 .vue 的工程无法执行 Typecheck。vue-tsc is not available; typecheck for Vue projects was not executed.',
        severity: 'error',
      }],
    }
  }
  return await new Promise<TypecheckResult>((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [vueTscBin, '--noEmit', '--pretty', 'false', '-p', tsconfigPath], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 取消传播：abort 时终止挂起的 vue-tsc 子进程（IDE-014-06 —— 不 kill 则
    // SIGCONT 后跑完，任务终态伪报 succeeded）。TaskService 对 abort 期错误统一记 cancelled。
    const onAbort = (): void => {
      if (child.exitCode === null) child.kill('SIGTERM')
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    child.on('close', () => {
      abortSignal?.removeEventListener('abort', onAbort)
      if (abortSignal?.aborted) {
        rejectResult(new Error('Typecheck 已被取消。Typecheck was aborted.'))
      }
    })
    const diagnostics: Diagnostic[] = []
    let outputTail = ''
    const consumeLine = (line: string): void => {
      const diagnostic = parseCompilerLine(line.trim(), projectRoot)
      if (diagnostic !== null) diagnostics.push(diagnostic)
    }
    const readers = [child.stdout, child.stderr].map((stream) => {
      let pending = ''
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        // 与任务日志的 4096 字符限制一致，只保留失败摘要的尾部。
        outputTail = (outputTail + chunk).slice(-4096)
        pending += chunk
        let end = pending.indexOf('\n')
        while (end >= 0) {
          consumeLine(pending.slice(0, end))
          pending = pending.slice(end + 1)
          end = pending.indexOf('\n')
        }
      })
      return () => consumeLine(pending)
    })
    child.on('error', (error) => {
      resolveResult({
        ok: false,
        executed: false,
        diagnostics: [{
          code: 'FH2_TYPECHECK_TOOL_FAILED',
          phase: 'typecheck',
          file: '.',
          message: `vue-tsc 启动失败：${error.message}`,
          severity: 'error',
        }],
      })
    })
    child.on('close', (code, signal) => {
      for (const flush of readers) flush()
      if (code !== 0 && !diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
        diagnostics.push({
          code: 'FH2_TYPECHECK_TOOL_FAILED',
          phase: 'typecheck',
          file: '.',
          message: `vue-tsc 执行失败（${signal === null ? `退出码 ${code}` : `信号 ${signal}`}）${outputTail.trim() === '' ? '，没有输出诊断。' : `：\n${outputTail.trim()}`}`,
          severity: 'error',
        })
      }
      const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error')
      resolveResult({
        ok: code === 0 && errors.length === 0,
        executed: true,
        diagnostics,
      })
    })
  })
}

function parseCompilerLine (line: string, projectRoot: string): Diagnostic | null {
  const match = TSC_LINE_PATTERN.exec(line)
  if (match === null) {
    const globalMatch = TSC_GLOBAL_LINE_PATTERN.exec(line)
    if (globalMatch === null) return null
    return {
      code: globalMatch[2]!,
      phase: 'typecheck',
      file: '.',
      message: globalMatch[3]!,
      severity: globalMatch[1] === 'warning' ? 'warning' : 'error',
    }
  }
  const file = match[1]
  const lineNumber = match[2]
  const columnNumber = match[3]
  const severity = match[4]
  const code = match[5]
  const message = match[6]
  if (file === undefined || lineNumber === undefined || columnNumber === undefined
    || severity === undefined || code === undefined || message === undefined) {
    return null
  }
  return {
    code,
    phase: 'typecheck',
    file: relativeDisplay(projectRoot, file),
    line: Number.parseInt(lineNumber, 10),
    column: Number.parseInt(columnNumber, 10),
    message,
    severity: severity === 'warning' ? 'warning' : 'error',
  }
}

function resolveVueTscBin (): string | null {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve('vue-tsc/bin/vue-tsc.js')
  } catch {
    return null
  }
}

function relativeDisplay (projectRoot: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(projectRoot, file)
  const fromRoot = relative(projectRoot, absolute)
  return fromRoot === '' || fromRoot.startsWith('..') ? file.replaceAll('\\', '/') : fromRoot.replaceAll('\\', '/')
}
