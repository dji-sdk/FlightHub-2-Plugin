// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { join } from 'node:path'

export const PACKAGE_MANIFEST_FILE = 'packages.json'

export interface PackageManifestEntry {
  readonly packageId: string;
  readonly name: string;
  readonly capabilityIds: readonly string[];
}

export class PackageError extends Error {
  constructor (
    readonly code: string,
    message: string,
    readonly file?: string,
  ) {
    super(message)
    this.name = 'PackageError'
  }
}

export function packageManifestPath (capabilityRoot: string): string {
  return join(capabilityRoot, PACKAGE_MANIFEST_FILE)
}
