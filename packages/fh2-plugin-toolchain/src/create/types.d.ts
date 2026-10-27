// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
declare module 'validate-npm-package-name' {
  interface ValidationResult {
    readonly validForNewPackages: boolean;
    readonly validForOldPackages: boolean;
    readonly errors?: readonly string[];
    readonly warnings?: readonly string[];
  }

  export default function validatePackageName (name: string): ValidationResult
}
