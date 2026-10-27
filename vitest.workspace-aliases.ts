// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { resolve } from 'node:path'

export const workspaceAliases: Record<string, string> = {
  'fh2-plugin-sdk/runtime-contract.json': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/runtime-contract.json'),
  'fh2-plugin-toolchain/rsbuild': resolve(import.meta.dirname, './packages/fh2-plugin-toolchain/src/rsbuild/index.ts'),
  'fh2-plugin-sdk/generator': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/src/generator/index.ts'),
  'fh2-plugin-sdk/backend': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/src/backend/index.ts'),
  'fh2-plugin-sdk/catalog': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/src/catalog/index.ts'),
  'fh2-plugin-toolchain': resolve(import.meta.dirname, './packages/fh2-plugin-toolchain/src/index.ts'),
  'fh2-plugin-sdk/view': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/src/view/index.ts'),
  'fh2-plugin-sdk': resolve(import.meta.dirname, './packages/fh2-plugin-sdk/src/index.ts'),
}
