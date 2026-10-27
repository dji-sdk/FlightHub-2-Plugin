// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * Tooling 契约公共出口（dist/tooling-contract.js 独立 tsup entry）。
 *
 * 导出契约投影、访问器与序列化器，供 Stage 3 导出器与外部校验消费。
 * 诊断扫描使用 Node FS/TypeScript AST；CLI/context 投影加载执行模块及 SDK/Rsbuild，
 * 本入口不是无运行依赖的纯数据模块。
 * 冻结不证明同源：旧契约含人工说明，新 runtime-policy 报告明确区分其身份。
 */

export * from './artifacts.js'
export * from './cli.js'
export * from './context.js'
export * from './diagnostics.js'
export * from './flows.js'
export * from './restrictions.js'
export * from './shared.js'
export * from './transforms.js'
export * from './policy.js'
