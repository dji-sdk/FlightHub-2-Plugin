// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { PROJECT_PATHS } from '../project-policy.js'

export const PLATFORM_OWNED_FILES = Object.freeze(['SIGNATURE', PROJECT_PATHS.packageManifest])
export const DEVELOPMENT_ONLY_DIRECTORIES = Object.freeze([PROJECT_PATHS.localState, 'node_modules'])
export const DEVELOPMENT_ONLY_FILES = Object.freeze(['.DS_Store', PROJECT_PATHS.buildInfo])
export const STANDALONE_PACK_EXCLUSIONS = Object.freeze({
  files: [...DEVELOPMENT_ONLY_FILES, ...PLATFORM_OWNED_FILES],
  directories: DEVELOPMENT_ONLY_DIRECTORIES,
  suffixes: ['.map'],
})
export const CAPABILITY_BACKEND_COPY_EXCLUSIONS = STANDALONE_PACK_EXCLUSIONS
export const CAPABILITY_ZIP_EXCLUSIONS = Object.freeze({
  files: ['.DS_Store', 'SIGNATURE'],
  directories: DEVELOPMENT_ONLY_DIRECTORIES,
  nestedFiles: PLATFORM_OWNED_FILES,
})
export function isPackExcluded (name: string, policy: typeof STANDALONE_PACK_EXCLUSIONS = STANDALONE_PACK_EXCLUSIONS): boolean {
  return policy.files.includes(name) || policy.directories.includes(name) || policy.suffixes.some(suffix => name.endsWith(suffix))
}

export const ZIP_COMPRESSION_LEVEL = 9
export const WINDOWS_RESERVED_NAMES = Object.freeze([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'COM\u00B9',
  'COM\u00B2',
  'COM\u00B3',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'LPT\u00B9',
  'LPT\u00B2',
  'LPT\u00B3',
])
export function compareArchivePaths (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
export function useDeflate (compressedBytes: number, sourceBytes: number): boolean {
  return compressedBytes < sourceBytes
}

export const BUILD_DIGEST_IGNORED_AT_ROOT = Object.freeze([PROJECT_PATHS.localState])
export const SOURCE_DIGEST_IGNORED_AT_ROOT = Object.freeze([PROJECT_PATHS.dist, PROJECT_PATHS.localState, 'node_modules'])
export const SOURCE_DIGEST_IGNORED_EVERYWHERE = Object.freeze(['node_modules'])
export const BACKEND_WATCH_TRANSACTION_PREFIX = `.${PROJECT_PATHS.dist}.fh2-`

/** These predicates are also used by Pack. No human description is interpreted as policy. */
export const BUILD_REPORT_REUSE_CHECKS = Object.freeze({
  hasExternalSourceDependencies: (entry: { readonly hasExternalSourceDependencies?: boolean }) => entry.hasExternalSourceDependencies === true,
  hasExternalConfigDependencies: (entry: { readonly hasExternalConfigDependencies?: boolean }) => entry.hasExternalConfigDependencies === true,
  sourceChangedDuringBuild: (entry: { readonly sourceChangedDuringBuild?: boolean }) => entry.sourceChangedDuringBuild === true,
  customConfig: (entry: { readonly configPath?: string; readonly configDigest?: string }) =>
    (entry.configPath === undefined) !== (entry.configDigest === undefined) || entry.configPath !== undefined,
})

export const BUILD_REPORT_MATCH_CHECKS = Object.freeze({
  capabilityId: (actual: string, expected: string) => actual === expected,
  metadataDigest: (actual: string, expected: string) => actual === expected,
  packageManifestRecorded: (actual: string | undefined) => actual !== undefined,
  packageManifestDigest: (actual: string | undefined, expected: string | undefined) => expected !== undefined && actual === expected,
  currentMembers: (entries: Readonly<Record<string, unknown>>, currentIds: readonly string[]) => {
    const current = new Set(currentIds)
    return Object.keys(entries).every(id => current.has(id))
  },
  distDigest: (entry: { readonly digest: string } | undefined, expected: string | undefined) => entry !== undefined && expected !== undefined && entry.digest === expected,
  sourceDigest: (actual: string, expected: string) => actual === expected,
})

/** undefined means all; an explicit empty set means none, as in the existing builder API. */
export function selectBuildProjects<T extends { readonly id: string }> (projects: readonly T[], filter: ReadonlySet<string> | undefined): readonly T[] {
  return filter === undefined ? projects : projects.filter(project => filter.has(project.id))
}
