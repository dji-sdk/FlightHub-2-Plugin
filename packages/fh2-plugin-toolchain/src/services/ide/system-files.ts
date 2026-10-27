// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { stat } from 'node:fs/promises'
import open from 'open'
import revealFile from 'reveal-file'
import { IdeRequestError } from '../../contracts/ide.js'
import type { IdeFsPathData } from '../../contracts/ide.js'
import { resolveWorkspacePath } from './files.js'

/** 路径展示保留服务器系统的分隔符，相对路径统一使用POSIX。 */
export function workspacePathInfo (root: string, rawPath: unknown): IdeFsPathData {
  return resolveWorkspacePath(root, rawPath)
}

/** 只接受工作区内相对路径；文件定位，目录打开自身。 */
export async function revealWorkspaceEntry (root: string, rawPath: unknown): Promise<IdeFsPathData> {
  const target = workspacePathInfo(root, rawPath)
  const stats = await stat(target.absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new IdeRequestError('FH2_IDE_NOT_FOUND', `文件或目录不存在：${target.relativePath}。`)
    }
    throw error
  })
  if (stats.isDirectory()) {
    await open(target.absolutePath)
  } else if (stats.isFile()) {
    await revealFile(target.absolutePath)
  } else {
    throw new IdeRequestError('FH2_IDE_BAD_REQUEST', '只能打开普通文件或目录。')
  }
  return target
}
