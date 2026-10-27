// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * fh2-web-ide —— 产物由 `fh2-plugin serve` 静态托管。
 * base './'：serve 的挂载点不固定（可能不是 `/`），相对路径保证资源都能命中。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  base: './',
  build: {
    outDir: '../apps/fh2-web-ide/dist',
    emptyOutDir: true,
    target: 'es2022',
    // Monaco 的语言包切得很碎，单块超 500KB 是常态，不需要告警噪音
    chunkSizeWarningLimit: 4096,
  },
  server: {
    port: 35320,
    // 本地开发直连 mock-api（scripts/mock-api.mjs），与 serve 同源行为一致
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:35321',
        changeOrigin: false,
      },
    },
  },
})
