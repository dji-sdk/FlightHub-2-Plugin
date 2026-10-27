// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from 'vitest/config'
import ideConfig from '../../ide/vitest.config.js'

// Reuse real Monaco Model resolution without changing IDE production or test configuration.
export default defineConfig({
  ...ideConfig,
  test: {
    ...ideConfig.test,
    name: 'tooling-ide-usage',
    include: ['../src/tooling-contract/ide-limitations.probe.ts'],
  },
})
