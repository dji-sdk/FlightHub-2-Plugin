// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * S8：工作流受审词表与语义校验（Workflow Schema facts + Semantic checker）。
 *
 * 这是规则的唯一事实源：IDE 画布（经 内部 browser-safe Core 同步消费）与 Serve 校验端点（`POST /api/workflow/validate`）共用同一实现，
 * 同输入必出同诊断。规则照 worker flowcheck 判据，纪律是「宁可漏判，不可误报」：
 * 词表取不到、脚本没选、action 不认识时一律放行；Action 未知值不以快照枚举判错
 * （插件自定义能力 `plugin.<名>` 仅 warning）。
 */
export * from './catalog.js'
export * from './semantics.js'
