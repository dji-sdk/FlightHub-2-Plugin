// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * W2/规则迁移：语义校验实现收敛到 Toolchain Core（S8）。
 *
 * 与 Core 的差异只有输入形状：Core 只消费工作流原始 JSON（`{ raw }`）；
 * 画布的 WorkflowDocument 满足该形状，graph 参数本就被忽略（结构问题由画布本地报），
 * 因此直接收敛签名，调用方（stores/workflow.ts 与本目录用例）同步更新。
 */
export * from '../../../../src/workflow/core/index.js'
