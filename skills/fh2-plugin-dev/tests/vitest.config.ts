// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({
  root,
  resolve: {
    alias: {
      'fh2-plugin-sdk/generator': resolve(root, 'packages/fh2-plugin-sdk/src/generator/index.ts'),
      'fh2-plugin-sdk': resolve(root, 'packages/fh2-plugin-sdk/src/index.ts'),
    },
  },
  test: {
    name: 'dev-skill-source',
    // String workspace entries override Vite root; pin the test root as well.
    root,
    environment: 'node',
    include: ['**/fh2-plugin-dev*/tests/create-source.test.ts'],
    testTimeout: 30_000,
  },
})
