// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/**
 * .vue 模块声明兜底：vue-tsc 会用 SFC 的精确类型解析真实文件，
 * 此声明只在编辑器 / 裸 tsc 场景下兜底（对齐 apps/mock-host-vue3 的做法）。
 */
import type { DefineComponent } from 'vue'

declare module '*.vue' {
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
