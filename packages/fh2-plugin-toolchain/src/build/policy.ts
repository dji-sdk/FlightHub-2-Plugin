// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { PROJECT_PATHS } from '../project-policy.js'

export interface BuildContextOptions {
  readonly supportsWatch: boolean;
  readonly supportsConfig: boolean;
  readonly supportsFilters: boolean;
}

export const BUILD_CONTEXT_OPTIONS = Object.freeze({
  'industry-capability-workspace': Object.freeze({ supportsWatch: false, supportsConfig: false, supportsFilters: false }),
  'capability-project': Object.freeze({ supportsWatch: true, supportsConfig: true, supportsFilters: true }),
  'frontend-plugin': Object.freeze({ supportsWatch: true, supportsConfig: true, supportsFilters: false }),
  'backend-plugin': Object.freeze({ supportsWatch: false, supportsConfig: false, supportsFilters: false }),
}) satisfies Readonly<Record<string, BuildContextOptions>>

/** CLI deduplicates frontend IDs before this existing Capability config condition. */
export function isCapabilityBuildConfigSelection (frontend: ReadonlySet<string>): boolean {
  return frontend.size === 1
}

/** Diagnostic phases assigned by the executing builders; not prose stage names. */
export const BUILD_PHASES = Object.freeze({ validate: 'config', generate: 'generate', resolve: 'resolve', compile: 'compile', commit: 'commit' } as const)
export const FRONTEND_OUTPUT_POLICY = Object.freeze({
  filename: { js: '[name].[contenthash:8].js', css: '[name].[contenthash:8].css' },
  asyncChunks: false,
  chunkStrategy: 'all-in-one',
  injectStyles: false,
})
export const PLUGIN_MODULE_POLICY = Object.freeze({
  vueResource: /\/node_modules\/(?:@vue\/[^/]+|vue)(?:\/|$)/,
  forbiddenTypePrefixes: ['css', 'asset'],
})
export const DIST_TRANSACTION_POLICY = Object.freeze({
  candidateSuffix: '.fh2-next-',
  backupSuffix: '.fh2-backup-',
})
export function distTransactionPrefix (name: string, kind: 'candidate' | 'backup'): string {
  return `.${name}${kind === 'candidate' ? DIST_TRANSACTION_POLICY.candidateSuffix : DIST_TRANSACTION_POLICY.backupSuffix}`
}
export const FRONTEND_WATCH_DIRECTORIES = Object.freeze([PROJECT_PATHS.frontendSource, PROJECT_PATHS.public])
export const FRONTEND_BACKEND_WATCH_DIRECTORIES = Object.freeze([PROJECT_PATHS.backend, PROJECT_PATHS.mock])
export const INFRASTRUCTURE_FAILURE_CODES = Object.freeze([
  'FH2_BUILD_RESULT_CLOSE_FAILED',
  'FH2_BUILD_WATCH_DEPENDENCY_ADD_FAILED',
  'FH2_ENVIRONMENT_STATS_MISSING',
  'FH2_UNEXPECTED_ENVIRONMENT_STATS',
  'FH2_RSBUILD_CREATE_FAILED',
  'FH2_RSBUILD_INFRASTRUCTURE_FAILED',
])
