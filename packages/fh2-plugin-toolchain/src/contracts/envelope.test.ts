// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { describe, expect, it } from 'vitest'
import { IDE_ERROR_STATUS } from './error-codes.js'
import { resultFailure, resultSuccess, serveFailure, serveSuccess } from './envelope.js'
import { parseDiagnostic } from './diagnostic.js'

describe('serve 信封', () => {
  it('成功：携带 schemaVersion 与 data', () => {
    expect(serveSuccess({ ok: 1 })).toEqual({ schemaVersion: 1, ok: true, data: { ok: 1 } })
  })

  it('业务失败：携带 code 与双语 message', () => {
    const failure = serveFailure('FH2_IDE_BAD_REQUEST', '参数错误。Bad request.')
    expect(failure).toEqual({
      schemaVersion: 1,
      ok: false,
      error: { code: 'FH2_IDE_BAD_REQUEST', message: '参数错误。Bad request.' },
    })
  })

  it('空结果：data 允许为空数组/空对象', () => {
    expect(serveSuccess([]).data).toEqual([])
    expect(serveSuccess({}).data).toEqual({})
  })
})

describe('mCP 结果信封', () => {
  it('成功/失败形态固定为 {ok,data}/{ok,error}', () => {
    expect(resultSuccess(3)).toEqual({ ok: true, data: 3 })
    expect(resultFailure('FH2_TASK_NOT_FOUND', 'task not found')).toEqual({
      ok: false,
      error: { code: 'FH2_TASK_NOT_FOUND', message: 'task not found' },
    })
  })
})

describe('错误映射', () => {
  it('每个错误码都有 HTTP 状态映射', () => {
    const codes: (keyof typeof IDE_ERROR_STATUS)[] = [
      'FH2_IDE_UNAUTHORIZED',
      'FH2_IDE_BAD_REQUEST',
      'FH2_IDE_PATH_ESCAPE',
      'FH2_IDE_NOT_FOUND',
      'FH2_IDE_NOT_A_FILE',
      'FH2_IDE_TOO_LARGE',
      'FH2_IDE_WRITE_FAILED',
      'FH2_IDE_COMMAND_FAILED',
      'FH2_IDE_INTERNAL',
      'FH2_IDE_ALREADY_EXISTS',
      'FH2_IDE_NOT_EMPTY',
      'FH2_IDE_ROOT_INVALID',
      'FH2_IDE_PROCESS_FAILED',
      'FH2_IDE_PROCESS_RUNNING',
      'FH2_FILE_CONFLICT',
    ]
    for (const code of codes) {
      expect(typeof IDE_ERROR_STATUS[code]).toBe('number')
    }
  })

  it('文件冲突映射为 409', () => {
    expect(IDE_ERROR_STATUS.FH2_FILE_CONFLICT).toBe(409)
  })
})

describe('parseDiagnostic', () => {
  const base = {
    code: 'FH2_VALIDATE_SCHEMA_MISSING',
    phase: 'schema',
    file: 'frontend/demo/fh2-plugin.json',
    message: '缺少字段 entry',
    severity: 'error',
  }

  it('接受合法诊断（成功样例）', () => {
    expect(parseDiagnostic(base)).toEqual(base)
  })

  it('接受带 1-based 行列与 hint 的诊断', () => {
    expect(parseDiagnostic({ ...base, line: 3, column: 7, hint: '补上 entry', path: 'frontend/demo' }))
      .toEqual({ ...base, line: 3, column: 7, hint: '补上 entry', path: 'frontend/demo' })
  })

  it('缺失必填字段返回 null', () => {
    expect(parseDiagnostic({ ...base, code: undefined })).toBeNull()
    expect(parseDiagnostic({ ...base, message: undefined })).toBeNull()
    expect(parseDiagnostic({ ...base, file: undefined })).toBeNull()
    expect(parseDiagnostic({ ...base, severity: undefined })).toBeNull()
    expect(parseDiagnostic({ ...base, phase: undefined })).toBeNull()
  })

  it('未知 phase/severity 返回 null', () => {
    expect(parseDiagnostic({ ...base, phase: 'lint' })).toBeNull()
    expect(parseDiagnostic({ ...base, severity: 'fatal' })).toBeNull()
  })

  it('行列必须为 1-based 正整数', () => {
    expect(parseDiagnostic({ ...base, line: 0 })).toBeNull()
    expect(parseDiagnostic({ ...base, column: -1 })).toBeNull()
    expect(parseDiagnostic({ ...base, line: 2.5 })).toBeNull()
  })

  it('接受 build 阶段与 info 级别', () => {
    expect(parseDiagnostic({ ...base, phase: 'typecheck', severity: 'info' })).not.toBeNull()
  })
})
