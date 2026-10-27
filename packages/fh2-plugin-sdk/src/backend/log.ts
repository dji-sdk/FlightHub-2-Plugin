// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

/** 脚本诊断日志:三种调用形态无条件注入,不看 allowlist。fields 只收标量(对象/数组字段会被丢弃并标记)。 */
export interface LogApi {
  info(message: string, fields?: Record<string, string | number | boolean>): void

  warn(message: string, fields?: Record<string, string | number | boolean>): void

  error(message: string, fields?: Record<string, string | number | boolean>): void

}
