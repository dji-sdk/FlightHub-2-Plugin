// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** scripts/scan-diagnostics.mjs 的类型声明（src 内守卫测试直接导入该脚本）。 */

export interface ScannedDiagnosticCode {
  /** 诊断码，如 'FH2_CAPABILITY_EMPTY'。 */
  readonly code: string
  /** 该码出现的源文件（相对 src/，排序去重）。 */
  readonly files: readonly string[]
}

/** 扫描 packageRoot/src 下的 'FH2_*' 字符串字面量，返回按 code 排序的去重列表。 */
export function scanDiagnosticCodes (packageRoot: string): ScannedDiagnosticCode[]
