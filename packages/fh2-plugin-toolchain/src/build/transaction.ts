// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BuildDiagnostic } from './types.js'
import { PluginBuildError } from './types.js'
import { BUILD_PHASES, distTransactionPrefix } from './policy.js'

export interface TransactionFileOperations {
  readonly exists: typeof existsSync;
  readonly mkdir: typeof mkdirSync;
  readonly rename: typeof renameSync;
  readonly rm: typeof rmSync;
}

const FILE_OPERATIONS: TransactionFileOperations = {
  exists: existsSync,
  mkdir: mkdirSync,
  rename: renameSync,
  rm: rmSync,
}

export function createCandidateDirectory (
  distRoot: string,
  operations: TransactionFileOperations = FILE_OPERATIONS,
): string {
  const candidate = join(dirname(distRoot), `${distTransactionPrefix(basename(distRoot), 'candidate')}${randomUUID()}`)
  operations.mkdir(candidate, { recursive: false })
  return candidate
}

export function removeCandidateDirectory (
  candidateRoot: string,
  operations: TransactionFileOperations = FILE_OPERATIONS,
): void {
  operations.rm(candidateRoot, { recursive: true, force: true })
}

export function commitCandidateDirectory (
  candidateRoot: string,
  distRoot: string,
  operations: TransactionFileOperations = FILE_OPERATIONS,
): readonly BuildDiagnostic[] {
  const backupRoot = join(dirname(distRoot), `${distTransactionPrefix(basename(distRoot), 'backup')}${randomUUID()}`)
  const hadDist = operations.exists(distRoot)
  let backedUp = false
  try {
    if (hadDist) {
      operations.rename(distRoot, backupRoot)
      backedUp = true
    }
    operations.rename(candidateRoot, distRoot)
  } catch (error) {
    if (backedUp) {
      try {
        operations.rename(backupRoot, distRoot)
      } catch (rollbackError) {
        throw new PluginBuildError([{
          code: 'FH2_DIST_COMMIT_ROLLBACK_FAILED',
          phase: BUILD_PHASES.commit,
          message: `提交 dist 失败且旧制品回滚失败：${message(error)}；回滚错误：${message(rollbackError)}`,
        }])
      }
    }
    throw new PluginBuildError([{
      code: 'FH2_DIST_COMMIT_FAILED',
      phase: BUILD_PHASES.commit,
      message: `提交 dist 失败，旧制品已保留：${message(error)}`,
    }])
  }

  if (!backedUp) return []
  try {
    operations.rm(backupRoot, { recursive: true, force: true })
    return []
  } catch (error) {
    return [{
      code: 'FH2_DIST_BACKUP_CLEANUP_FAILED',
      phase: BUILD_PHASES.commit,
      file: backupRoot,
      message: `新 dist 已提交，但旧制品备份清理失败：${message(error)}`,
    }]
  }
}

function message (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
