// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'traffic-capabilities-backend',
    environment: 'node',
    // 根 tests/ 是跨能力回归;*/backend/*/tests/ 是各后端插件自己的 handler 单测。
    include: ['tests/**/*.test.ts', '*/backend/*/tests/**/*.test.ts'],
  },
})
