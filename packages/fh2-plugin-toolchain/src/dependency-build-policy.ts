// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
/** pnpm installation policy shared by SOURCE and newly created projects. */
export const DEPENDENCY_BUILD_POLICY = Object.freeze({
  onlyBuiltDependencies: ['esbuild'],
  // These scripts are optional resolver fallback/advertising, not the build tool.
  ignoredBuiltDependencies: ['core-js', 'unrs-resolver'],
})
