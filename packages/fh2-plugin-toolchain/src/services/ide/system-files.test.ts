// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import open from 'open'
import revealFile from 'reveal-file'
import { revealWorkspaceEntry, workspacePathInfo } from './system-files.js'

vi.mock('open', () => ({ default: vi.fn() }))
vi.mock('reveal-file', () => ({ default: vi.fn() }))

describe('文件树系统操作', () => {
  let base: string
  let root: string
  beforeEach(async () => {
    vi.mocked(open).mockReset()
    vi.mocked(revealFile).mockReset()
    base = await mkdtemp(join(tmpdir(), 'fh2-system-files-'))
    root = join(base, 'workspace')
    await mkdir(join(root, '目录 with spaces'), { recursive: true })
    await writeFile(join(root, '目录 with spaces', '中文 #file.ts'), '')
  })
  afterEach(async () => rm(base, { recursive: true, force: true }))

  it('返回原生绝对路径和规范化POSIX路径，根路径为点', () => {
    expect(workspacePathInfo(root, './目录 with spaces/中文 #file.ts')).toEqual({
      absolutePath: join(root, '目录 with spaces', '中文 #file.ts'),
      relativePath: '目录 with spaces/中文 #file.ts',
    })
    expect(workspacePathInfo(root, '.')).toEqual({ absolutePath: root, relativePath: '.' })
    expect(workspacePathInfo(root, 'deleted.ts').relativePath).toBe('deleted.ts')
  })

  it('文件通过库选中，目录和根通过库打开自身', async () => {
    await revealWorkspaceEntry(root, '目录 with spaces/中文 #file.ts')
    expect(revealFile).toHaveBeenCalledWith(join(root, '目录 with spaces', '中文 #file.ts'))
    expect(open).not.toHaveBeenCalled()
    await revealWorkspaceEntry(root, '目录 with spaces')
    await revealWorkspaceEntry(root, '.')
    expect(vi.mocked(open).mock.calls).toEqual([[join(root, '目录 with spaces')], [root]])
  })

  it('无效或越界路径、缺失文件均不调用系统库', async () => {
    for (const path of [undefined, '', '../outside', '/absolute', 'C:\\outside', 'src\\file', 'bad\0name']) {
      await expect(revealWorkspaceEntry(root, path)).rejects.toMatchObject({ name: 'IdeRequestError' })
    }
    await expect(revealWorkspaceEntry(root, 'missing.ts')).rejects.toMatchObject({ code: 'FH2_IDE_NOT_FOUND' })
    expect(open).not.toHaveBeenCalled()
    expect(revealFile).not.toHaveBeenCalled()
  })

  it('拒绝指向工作区外的符号链接，允许工作区内部链接', async () => {
    await writeFile(join(base, 'outside.ts'), '')
    await symlink(join(base, 'outside.ts'), join(root, 'escape.ts'))
    await symlink(join(root, '目录 with spaces', '中文 #file.ts'), join(root, 'inside.ts'))
    expect(() => workspacePathInfo(root, 'escape.ts')).toThrow()
    await expect(revealWorkspaceEntry(root, 'escape.ts')).rejects.toMatchObject({ code: 'FH2_IDE_PATH_ESCAPE' })
    expect(revealFile).not.toHaveBeenCalled()
    await revealWorkspaceEntry(root, 'inside.ts')
    expect(revealFile).toHaveBeenCalledWith(join(root, 'inside.ts'))
  })

  it('系统启动失败继续抛出，HTTP层可报告失败', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('无法启动文件管理器'))
    await expect(revealWorkspaceEntry(root, '.')).rejects.toThrow('无法启动文件管理器')
    vi.mocked(revealFile).mockRejectedValueOnce(new Error('无法定位文件'))
    await expect(revealWorkspaceEntry(root, '目录 with spaces/中文 #file.ts')).rejects.toThrow('无法定位文件')
  })
})
