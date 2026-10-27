// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'tsup'

/**
 * SDK 两份产物合并到一份 tsup config（数组形式）：
 * - 浏览器面（index / view/index）：打进插件产物，随插件分发
 * - Node-only generator：只在构建期跑，不进插件产物
 *
 * 两个 config 都 `clean:false`——避免 config1 的 clean 在 config2 写完
 * `dist/generator/index.d.ts` 后又把它删掉（审视报告第四轮 #1：实测
 * 构建后 generator/index.d.ts 缺失，check:pack 失败）。预清理改由
 * package.json `build` 脚本 `rimraf dist && tsup` 显式做一次。
 */
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'view/index': 'src/view/index.ts',
      'catalog/index': 'src/catalog/index.ts',
      // backend 子路径:类型-only(由 toolchain typegen 生成,勿手改);
      // JS 产物是空占位,消费方只吃 d.ts。
      'backend/index': 'src/backend/index.ts',
    },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    // SDK 会被真实宿主通过本地软链直接消费；浏览器产物必须自包含，不能要求宿主
    // 再声明或解析 SDK 的实现依赖。
    noExternal: ['postcss-value-parser'],
    dts: true,
    sourcemap: true,
    clean: false,
    // JSON Schema 作为资源文件平移到 dist
    onSuccess: async () => {
      mkdirSync('dist/schema', { recursive: true })
      copyFileSync('src/schema/manifest.schema.json', 'dist/schema/manifest.schema.json')
    },
  },
  {
    entry: { 'generator/index': 'src/generator/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    noExternal: ['postcss-value-parser'],
    dts: true,
    sourcemap: true,
    clean: false, // 不与浏览器面冲突
  },
])
