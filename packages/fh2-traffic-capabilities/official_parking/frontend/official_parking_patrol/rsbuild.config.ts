// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineConfig } from '@rsbuild/core'
import { pluginVue } from '@rsbuild/plugin-vue'
import { fh2Plugin } from 'fh2-plugin-toolchain/rsbuild'

export default defineConfig({
  plugins: [
    pluginVue(),
    fh2Plugin({
      manifestPath: './fh2-plugin.json',
      pluginEntry: './src/plugin.ts',
      validateOnBuild: true,
    }),
  ],
  output: { distPath: { root: 'dist' } },
})
