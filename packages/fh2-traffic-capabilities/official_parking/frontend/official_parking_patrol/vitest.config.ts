// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [Vue()],
  test: {
    name: 'parking-patrol-example',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
