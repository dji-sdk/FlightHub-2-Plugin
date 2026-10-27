// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import Vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { workspaceAliases } from '../../../vitest.workspace-aliases.js'

/**
 * monaco-editor 0.52 的 marked.js 里留了个指向 `marked.umd.js.map` 的 sourceMappingURL，
 * 但该 .map 并未随包发布 —— Vite 每次加载都会打一条 ENOENT 警告。纯噪音，直接摘掉引用。
 */
const stripStaleSourcemapRefs: Plugin = {
  name: 'fh2-strip-stale-sourcemap-refs',
  enforce: 'pre',
  load (id) {
    if (!id.includes('monaco-editor') || !id.endsWith('.js')) return null
    const code = readFileSync(id, 'utf8')
    if (!code.includes('sourceMappingURL')) return null
    return { code: code.replace(/\/\/# sourceMappingURL=\S*/g, ''), map: null }
  },
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [stripStaleSourcemapRefs, Vue()],
  // monaco-editor 只声明了 `module` 入口，Node 默认解析找不到它
  resolve: { mainFields: ['module', 'browser', 'main'], alias: [
    // 单测消费真实 Model API；浏览器语言 worker 由 IDE E2E 验证，happy-dom 不启动它。
    { find: /^monaco-editor$/, replacement: createRequire(import.meta.url).resolve('monaco-editor/esm/vs/editor/editor.api.js') },
    ...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })),
  ] },
  test: {
    name: 'fh2-web-ide',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // naive-ui 具名导入（如 NScrollbar）经 vite-node 内联处理：
    // 外置给 Node 原生 ESM 时 vueuc 的 CJS 产物无法做命名导出探测
    server: { deps: { inline: [/naive-ui/, /vueuc/] } },
  },
})
