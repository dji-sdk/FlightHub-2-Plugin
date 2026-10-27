// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/* eslint-disable node/prefer-global/process */
import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'rsbuild/index': 'src/rsbuild/index.ts',
      'source-build-rules': 'src/source-build-rules.ts',
      // 契约独立出口：生产规则投影与人工说明；CLI/context 加载执行模块及 SDK/Rsbuild，非纯数据入口。
      'tooling-contract': 'src/tooling-contract/index.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: true,
    sourcemap: true,
    // watch 模式下不 clean：避免删 dist 的瞬间插件的 fh2-plugin build import 不到
    clean: process.env.FH2_WATCH !== '1',
    external: ['@rsbuild/core', 'fh2-plugin-sdk', 'ajv', 'chokidar', 'es-module-lexer', 'jsonc-parser', 'open', 'reveal-file', 'semver', 'ws', 'typescript-language-server'],
  },
  {
    // CLI 分发与 MCP stdio 入口/内部 worker（T4）同一构建：cli 惰性
    // import('./mcp/main.js') 跨 entry 引用保持 dist/mcp/main.js 路径，
    // worker 解析（resolveServiceWorkerEntry）依赖该布局。
    // zod/@modelcontextprotocol/sdk 随包发布（mcp/main 的依赖）。
    entry: {
      cli: 'src/cli.ts',
      'mcp/main': 'src/mcp/main.ts',
      'tasks/service-worker': 'src/services/tasks/service-worker.ts',
      'tasks/run-worker': 'src/services/tasks/run-worker.ts',
    },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: false,
    sourcemap: true,
    clean: false,
    external: ['@rsbuild/core', 'fh2-plugin-sdk', '@modelcontextprotocol/sdk', 'zod', 'minisearch', 'ajv', 'chokidar', 'es-module-lexer', 'jsonc-parser', 'open', 'reveal-file', 'semver', 'ws', 'typescript-language-server'],
    banner: { js: '#!/usr/bin/env node' },
  },
])
