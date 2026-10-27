// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { IdeTreeNode } from '../../contracts/ide.js'
import { readTreeChildren, readWorkspaceTree } from './files.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fh2-tree-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function put (path: string, content = ''): void {
  const segments = path.split('/')
  mkdirSync(join(root, ...segments.slice(0, -1)), { recursive: true })
  writeFileSync(join(root, path), content)
}
function find (nodes: readonly IdeTreeNode[], path: string): IdeTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.kind === 'dir') {
      const child = find(node.children, path)
      if (child) return child
    }
  }
  return undefined
}

it('生成目录多层单层加载，所有后代继承置灰，点目录可见且不跟随符号链接', async () => {
  put('dist/a/b/file.js')
  put('node_modules/.pnpm/pkg/lib/index.js')
  put('.vscode/settings.json')
  put('.github/workflows/ci.yml')
  put('.git/config')
  put('.DS_Store')
  put('.temp.fh2-ide-tmp')
  // Windows 用 junction 模拟目录链接（无需开发者模式；lstat 同样呈现为链接）
  symlinkSync(tmpdir(), join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const tree = (await readWorkspaceTree({ root })).tree
  expect(find(tree, 'dist')).toMatchObject({ generated: true, childrenLoaded: false, children: [] })
  expect(find(tree, '.vscode/settings.json')).toBeDefined()
  expect(find(tree, '.github/workflows/ci.yml')).toBeDefined()
  for (const path of ['.git', '.DS_Store', '.temp.fh2-ide-tmp', 'outside']) expect(find(tree, path)).toBeUndefined()
  for (const path of ['dist', 'dist/a', 'dist/a/b', 'node_modules', 'node_modules/.pnpm', 'node_modules/.pnpm/pkg', 'node_modules/.pnpm/pkg/lib']) {
    const { children } = await readTreeChildren(root, path)
    expect(children).toHaveLength(1)
    expect(children[0]?.generated).toBe(true)
    if (children[0]?.kind === 'dir') expect(children[0]).toMatchObject({ childrenLoaded: false, children: [] })
  }
  await expect(readTreeChildren(root, 'outside')).rejects.toMatchObject({ code: 'FH2_IDE_PATH_ESCAPE' })
})

it('普通截断目录也可继续加载，空目录有明确已加载状态', async () => {
  put('src/a/b/file.ts')
  mkdirSync(join(root, 'empty'))
  const shallow = await readWorkspaceTree({ root, maxDepth: 1 })
  expect(shallow.truncated).toBe(true)
  expect(find(shallow.tree, 'src')).toMatchObject({ childrenLoaded: false })
  expect((await readTreeChildren(root, 'src')).children[0]).toMatchObject({ path: 'src/a', childrenLoaded: false })
  expect((await readTreeChildren(root, 'src/a/b')).children[0]?.path).toBe('src/a/b/file.ts')
  expect(find((await readWorkspaceTree({ root })).tree, 'empty')).toMatchObject({ childrenLoaded: true, children: [] })
  const limited = await readWorkspaceTree({ root, maxNodes: 2 })
  expect(limited.truncated).toBe(true)
  expect(find(limited.tree, 'src')).toMatchObject({ childrenLoaded: false })
})

it('根和嵌套gitignore按作用域匹配，不隐藏或裁掉成员，修改删除规则即时生效', async () => {
  put('.gitignore', '# comment\n*.log\n/root.txt\ncache/\n!keep.log\n!sub/allow.log\nfrontend/\n')
  put('root.txt')
  put('sub/root.txt')
  put('sub/other.log')
  put('sub/keep.log')
  put('sub/allow.log')
  put('sub/nested.log')
  put('sub/.gitignore', '!other.log\nnested.log\n')
  put('other/other.log')
  put('cache/.gitignore', '!file.log')
  put('cache/file.log')
  put('frontend/exp_ui/fh2-plugin.json')
  const tree = (await readWorkspaceTree({ root })).tree
  for (const path of ['root.txt', 'sub/nested.log', 'other/other.log', 'cache/file.log', 'frontend/exp_ui/fh2-plugin.json']) expect(find(tree, path)?.ignored).toBe(true)
  for (const path of ['sub/root.txt', 'sub/other.log', 'sub/keep.log', 'sub/allow.log']) expect(find(tree, path)?.ignored).toBeUndefined()
  expect((await readTreeChildren(root, 'sub')).children.find(node => node.name === 'other.log')?.ignored).toBeUndefined()
  put('sub/.gitignore', '*.log')
  expect(find((await readWorkspaceTree({ root })).tree, 'sub/keep.log')?.ignored).toBe(true)
  rmSync(join(root, 'sub/.gitignore'))
  expect(find((await readWorkspaceTree({ root })).tree, 'sub/keep.log')?.ignored).toBeUndefined()
  rmSync(join(root, '.gitignore'))
  expect(find((await readWorkspaceTree({ root })).tree, 'cache/file.log')?.ignored).toBeUndefined()
})

it('git通配符、转义注释、目录规则和大小写按路径正确区分', async () => {
  put('.gitignore', '\\#literal\n\\!literal\n**/temp/*.txt\nlogs/\n*.LOG\n')
  for (const path of ['#literal', '!literal', 'a/temp/file.txt', 'a/temp/file.js', 'logs/file.txt', 'other/logs', 'a.LOG', 'a.log']) put(path)
  const { tree } = await readWorkspaceTree({ root })
  for (const path of ['#literal', '!literal', 'a/temp/file.txt', 'logs/file.txt', 'a.LOG']) expect(find(tree, path)?.ignored).toBe(true)
  for (const path of ['a/temp/file.js', 'other/logs', 'a.log']) expect(find(tree, path)?.ignored).toBeUndefined()
})
