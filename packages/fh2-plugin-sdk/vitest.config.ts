// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'sdk',
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
