// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
// 本文件由 fh2-plugin-toolchain typegen 生成,勿手改。
// 来源契约: 平台契约 backend catalog 与 errors（contractsVersion 1.1.0）。
// 重新生成: WRITE_BACKEND_TYPES=1 pnpm --filter fh2-plugin-toolchain test -- src/backend/typegen

/** 启动内部作业流程:能力按插件 allowlist 在当前三种 form 注入。already=true 不是错误,是重复投递的正常表现。 */
export interface FlowApi {
  start(flowName: string, bizID: string, seed: Record<string, unknown>): {
    already: boolean
  }

}
