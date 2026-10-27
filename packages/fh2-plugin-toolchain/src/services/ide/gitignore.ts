// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ignore from 'ignore'
import type { Ignore } from 'ignore'

interface Scope {
  directory: string;
  rules: Ignore;
}

/** 单次文件树请求内缓存各级规则，下一次请求自然读取最新磁盘内容。 */
export class WorkspaceGitIgnore {
  readonly warnings: string[] = []
  private readonly scopes = new Map<string, Promise<readonly Scope[]>>()
  constructor (private readonly root: string) {}

  private rulesFor (directory: string): Promise<readonly Scope[]> {
    const cached = this.scopes.get(directory)
    if (cached) return cached
    const pending = (async (): Promise<readonly Scope[]> => {
      const parent = directory === '' ? [] : await this.rulesFor(dirname(directory) === '.' ? '' : dirname(directory))
      const file = directory === '' ? '.gitignore' : `${directory}/.gitignore`
      try {
        const stats = await lstat(join(this.root, file))
        if (!stats.isFile()) return parent // 不读取符号链接或工作区外规则。
        const rules = ignore({ ignorecase: false }).add(await readFile(join(this.root, file), 'utf8'))
        return [...parent, { directory, rules }]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warnings.push(`无法读取 ${file} 的忽略规则：${error instanceof Error ? error.message : String(error)}`)
        return parent
      }
    })()
    this.scopes.set(directory, pending)
    return pending
  }

  async ignores (path: string, isDirectory: boolean): Promise<boolean> {
    const segments = path.split('/')
    // Git不能在父目录仍被忽略时，通过子目录规则重新包含其内部文件。
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join('/')
      const parent = segments.slice(0, index).join('/')
      const directory = index < segments.length - 1 || isDirectory
      let ignored = false
      for (const scope of await this.rulesFor(parent)) {
        const localPath = scope.directory === '' ? prefix : prefix.slice(scope.directory.length + 1)
        const result = scope.rules.test(`${localPath}${directory ? '/' : ''}`)
        if (result.ignored) ignored = true
        else if (result.unignored) ignored = false
      }
      if (ignored) return true
    }
    return false
  }
}
