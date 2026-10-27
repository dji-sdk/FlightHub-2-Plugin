// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginBuildError } from './types.js'
import {
  commitCandidateDirectory,
  createCandidateDirectory,
  removeCandidateDirectory,
} from './transaction.js'
import type { TransactionFileOperations } from './transaction.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('dist candidate transaction', () => {
  it('成功时原子替换 dist 并清理 backup', () => {
    const root = temporaryRoot()
    const dist = join(root, 'dist')
    mkdirSync(dist)
    writeFileSync(join(dist, 'version.txt'), 'old')
    const candidate = createCandidateDirectory(dist)
    writeFileSync(join(candidate, 'version.txt'), 'new')

    expect(commitCandidateDirectory(candidate, dist)).toEqual([])
    expect(readFileSync(join(dist, 'version.txt'), 'utf8')).toBe('new')
    expect(readdirSync(root).some(file => file.includes('.fh2-backup-'))).toBe(false)
  })

  it('candidate rename 失败时恢复旧 dist，候选可由 Runner 清理', () => {
    const root = temporaryRoot()
    const dist = join(root, 'dist')
    mkdirSync(dist)
    writeFileSync(join(dist, 'version.txt'), 'old')
    const candidate = createCandidateDirectory(dist)
    writeFileSync(join(candidate, 'version.txt'), 'new')
    const operations: TransactionFileOperations = {
      exists: existsSync,
      mkdir: mkdirSync,
      rm: rmSync,
      rename: ((source: string, target: string) => {
        if (source === candidate) throw new Error('injected commit failure')
        renameSync(source, target)
      }) as typeof renameSync,
    }

    expect(() => commitCandidateDirectory(candidate, dist, operations)).toThrow(PluginBuildError)
    expect(readFileSync(join(dist, 'version.txt'), 'utf8')).toBe('old')
    expect(readFileSync(join(candidate, 'version.txt'), 'utf8')).toBe('new')
    removeCandidateDirectory(candidate)
    expect(existsSync(candidate)).toBe(false)
  })
})

function temporaryRoot (): string {
  const root = mkdtempSync(join(tmpdir(), 'fh2-build-transaction-'))
  directories.push(root)
  return root
}
