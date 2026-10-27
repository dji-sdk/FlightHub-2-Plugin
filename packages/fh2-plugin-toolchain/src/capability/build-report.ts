// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROJECT_PATHS } from '../project-policy.js'
import { BACKEND_WATCH_TRANSACTION_PREFIX, BUILD_DIGEST_IGNORED_AT_ROOT, SOURCE_DIGEST_IGNORED_AT_ROOT, SOURCE_DIGEST_IGNORED_EVERYWHERE } from './policy.js'

export interface BuildReportPluginEntry {
  readonly status: 'success';
  readonly version: string;
  readonly digest: string;
  readonly sourceDigest: string;
  readonly configPath?: string;
  readonly configDigest?: string;
  readonly hasExternalSourceDependencies?: boolean;
  readonly hasExternalConfigDependencies?: boolean;
  readonly sourceChangedDuringBuild?: boolean;
}

export interface BuildReport {
  readonly capabilityId: string;
  readonly metadataDigest: string;
  readonly packageManifestDigest?: string;
  readonly frontend: Readonly<Record<string, BuildReportPluginEntry>>;
  readonly backend: Readonly<Record<string, BuildReportPluginEntry>>;
}

export interface BuildReportCandidate {
  readonly reportPath: string;
  readonly candidatePath: string;
}

export function digestBuildDirectory (root: string): string {
  return digestDirectory(root, new Set(BUILD_DIGEST_IGNORED_AT_ROOT), new Set(), true)
}

export function digestSourceDirectory (root: string): string {
  return digestDirectory(
    root,
    new Set(SOURCE_DIGEST_IGNORED_AT_ROOT),
    new Set(SOURCE_DIGEST_IGNORED_EVERYWHERE),
    true,
    true,
  )
}

export function digestFile (path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function digestDirectory (
  root: string,
  ignoredAtRoot: ReadonlySet<string>,
  ignoredEverywhere: ReadonlySet<string>,
  includeHidden: boolean,
  ignoreBuildCandidates = false,
): string {
  const resolvedRoot = resolve(root)
  const files: string[] = []
  collectFiles(
    resolvedRoot,
    resolvedRoot,
    files,
    ignoredAtRoot,
    ignoredEverywhere,
    includeHidden,
    ignoreBuildCandidates,
  )
  const digest = createHash('sha256')
  for (const file of files.sort(compareText)) {
    digest.update(file)
    digest.update('\0')
    digest.update(createHash('sha256').update(readFileSync(resolve(resolvedRoot, file))).digest('hex'))
    digest.update('\n')
  }
  return digest.digest('hex')
}

export function writeBuildReport (capabilityRoot: string, report: BuildReport): void {
  const candidate = createBuildReportCandidate(capabilityRoot, report)
  try {
    renameSync(candidate.candidatePath, candidate.reportPath)
  } finally {
    discardBuildReportCandidate(candidate)
  }
}

export function createBuildReportCandidate (capabilityRoot: string, report: BuildReport): BuildReportCandidate {
  const reportPath = buildReportPath(capabilityRoot)
  const candidatePath = join(dirname(reportPath), `.build-report.${randomUUID()}.tmp`)
  writeFileSync(candidatePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return Object.freeze({ reportPath, candidatePath })
}

export function discardBuildReportCandidate (candidate: BuildReportCandidate): void {
  rmSync(candidate.candidatePath, { force: true })
}

export function removeBuildReport (capabilityRoot: string): void {
  const root = realpathSync(capabilityRoot)
  const reportDirectory = join(root, PROJECT_PATHS.localState)
  if (!existsSync(reportDirectory)) return
  assertReportDirectory(root, reportDirectory)
  rmSync(join(reportDirectory, PROJECT_PATHS.buildReport), { force: true })
}

export function buildReportPath (capabilityRoot: string): string {
  const root = realpathSync(capabilityRoot)
  const reportDirectory = join(root, PROJECT_PATHS.localState)
  if (!existsSync(reportDirectory)) mkdirSync(reportDirectory, { recursive: true })
  assertReportDirectory(root, reportDirectory)
  return join(reportDirectory, PROJECT_PATHS.buildReport)
}

function assertReportDirectory (root: string, directory: string): void {
  const stat = lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`.fh2 必须是 Capability 根内的普通目录：${directory}`)
  }
  const realDirectory = realpathSync(directory)
  const fromRoot = relative(root, realDirectory)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`.fh2 真实路径越过 Capability 根：${directory}`)
  }
}

function collectFiles (
  root: string,
  directory: string,
  files: string[],
  ignoredAtRoot: ReadonlySet<string>,
  ignoredEverywhere: ReadonlySet<string>,
  includeHidden: boolean,
  ignoreBuildCandidates: boolean,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ((!includeHidden && entry.name.startsWith('.'))
      || (directory === root && ignoredAtRoot.has(entry.name))
      || ignoredEverywhere.has(entry.name)
      || (ignoreBuildCandidates && entry.name.startsWith(BACKEND_WATCH_TRANSACTION_PREFIX))) {
      continue
    }
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      collectFiles(
        root,
        path,
        files,
        ignoredAtRoot,
        ignoredEverywhere,
        includeHidden,
        ignoreBuildCandidates,
      )
      continue
    }
    if (!entry.isFile() || !statSync(path).isFile()) continue
    const relativePath = relative(root, path).split(sep).join('/')
    files.push(relativePath)
  }
}

function compareText (left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Expose the executing digest functions and their closure data for implementation identity only. */
export const BUILD_REPORT_DIGEST_IMPLEMENTATION = Object.freeze({
  functions: { digestBuildDirectory, digestSourceDirectory, digestFile, digestDirectory, collectFiles, compareText },
  data: {
    buildIgnoredAtRoot: BUILD_DIGEST_IGNORED_AT_ROOT,
    sourceIgnoredAtRoot: SOURCE_DIGEST_IGNORED_AT_ROOT,
    sourceIgnoredEverywhere: SOURCE_DIGEST_IGNORED_EVERYWHERE,
    buildCandidatePrefix: BACKEND_WATCH_TRANSACTION_PREFIX,
    pathSeparator: sep,
  },
})
