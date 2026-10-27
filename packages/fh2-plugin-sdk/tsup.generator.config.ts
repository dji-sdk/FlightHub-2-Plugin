// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from 'tsup'

/**
 * 类型生成器是 **Node-only**：只在构建期跑，不进插件产物。
 * 与浏览器面分开构建，platform 不同，且必须在主构建（clean: true）之后。
 */
export default defineConfig({
  entry: { 'generator/index': 'src/generator/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: false,
})
