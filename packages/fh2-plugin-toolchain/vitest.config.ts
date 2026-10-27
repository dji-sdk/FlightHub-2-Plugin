// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import process from 'node:process'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'fh2-plugin-sdk/generator': resolve(import.meta.dirname, '../fh2-plugin-sdk/src/generator/index.ts'),
      'fh2-plugin-sdk': resolve(import.meta.dirname, '../fh2-plugin-sdk/src/index.ts'),
    },
  },
  test: {
    testTimeout: process.env.FH2_TEST_GROUP === 'integration' ? 60_000 : 5_000,
    hookTimeout: process.env.FH2_TEST_GROUP === 'integration' ? 60_000 : 10_000,
    name: 'toolchain',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
