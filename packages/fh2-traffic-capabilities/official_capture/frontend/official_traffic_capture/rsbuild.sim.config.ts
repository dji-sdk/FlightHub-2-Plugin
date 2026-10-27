// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { defineConfig } from '@rsbuild/core'
import { pluginVue } from '@rsbuild/plugin-vue'
import { createSimExtractMiddleware } from './test-pages/lane-change-sim/sim/djmd/extract-api'

/**
 * 变道抓拍算法验证模拟器的独立 dev/build 配置。
 *
 * 与 rsbuild.config.ts（fh2Plugin 正式插件构建）完全独立：
 * - 不读取 fh2-plugin.json、不产出插件 dist/，输出到 dist-sim/。
 * - `pnpm sim` 启动；publicDir 指向 test-pages/lane-change-sim/public 提供内置录制。
 * - dev 中间件 /sim-api/extract：真机录像验证 tab 上传 MP4 后由本机
 *   ffmpeg 抽取 djmd 检测数据轨并转成 SEI NDJSON（仅本地调试用）。
 */
export default defineConfig({
  plugins: [pluginVue()],
  html: {
    title: '变道抓拍 — 算法验证模拟器（traffic-capture-plugin）',
    template: './test-pages/lane-change-sim/index.html',
  },
  source: {
    entry: {
      sim: './test-pages/lane-change-sim/main.ts',
    },
  },
  output: {
    distPath: {
      root: 'dist-sim',
    },
    filenameHash: false,
    minify: false,
  },
  server: {
    port: 35430,
    publicDir: {
      name: resolve(__dirname, 'test-pages/lane-change-sim/public'),
      copyOnBuild: true,
    },
  },
  dev: {
    setupMiddlewares: (middlewares) => {
      middlewares.unshift(createSimExtractMiddleware())
    },
  },
})
