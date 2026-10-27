// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { TreeNode } from '../api/types.js'
import { useFileTreeStore } from './file-tree.js'

function dir (name: string, path: string, children: readonly TreeNode[] = [], generated = false): TreeNode {
  return { name, path, kind: 'dir', children, ...(generated ? { generated: true } : {}) }
}

function file (name: string, path: string): TreeNode {
  return { name, path, kind: 'file' }
}

const TREE: readonly TreeNode[] = [
  dir('src', 'src', [
    dir('views', 'src/views', [file('panel.ts', 'src/views/panel.ts')]),
    file('plugin.ts', 'src/plugin.ts'),
  ]),
  file('fh2-plugin.json', 'fh2-plugin.json'),
]

describe('file-tree store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('allFiles / allDirectories 深度遍历', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, false)
    expect(tree.allFiles).toEqual(['src/views/panel.ts', 'src/plugin.ts', 'fh2-plugin.json'])
    expect(tree.allDirectories).toEqual(['src', 'src/views'])
  })

  it('生成目录：allFiles/allDirectories 跳过其子树，find/filesUnder 仍可命中', () => {
    const tree = useFileTreeStore()
    const withGenerated: readonly TreeNode[] = [
      dir('node_modules', 'node_modules', [dir('left-pad', 'node_modules/left-pad', [file('index.js', 'node_modules/left-pad/index.js')], true)], true),
      dir('src', 'src', [file('plugin.ts', 'src/plugin.ts')]),
      dir('dist', 'dist', [file('bundle.js', 'dist/bundle.js')], true),
    ]
    tree.setTree(withGenerated, false)
    // 派生数据（搜索/工作流候选/打包成员推导）不受生成内容污染
    expect(tree.allFiles).toEqual(['src/plugin.ts'])
    // 生成目录本体可见（树序），但子树不进派生数据
    expect(tree.allDirectories).toEqual(['node_modules', 'src', 'dist'])
    // find / filesUnder 全量不跳：删除前列清单等 UI 逻辑仍工作
    expect(tree.find('node_modules/left-pad')?.kind).toBe('dir')
    expect(tree.filesUnder('node_modules')).toEqual(['node_modules/left-pad/index.js'])
  })

  it('生成目录：isEmptyDirectory 不把未加载 children 误报为空', () => {
    const tree = useFileTreeStore()
    tree.setTree([dir('node_modules', 'node_modules', [], true), dir('empty', 'empty')], false)
    expect(tree.isEmptyDirectory('node_modules')).toBe(false)
    expect(tree.isEmptyDirectory('empty')).toBe(true)
  })

  it('未加载的普通目录、已加载空目录与刷新代号独立于置灰属性', () => {
    const tree = useFileTreeStore()
    tree.setTree([{ name: 'cache', path: 'cache', kind: 'dir', children: [], childrenLoaded: false, ignored: true }], false)
    const version = tree.treeVersion
    expect(tree.needsChildren('cache')).toBe(true)
    expect(tree.isEmptyDirectory('cache')).toBe(false)
    tree.setChildren('cache', [])
    expect(tree.needsChildren('cache')).toBe(false)
    expect(tree.isEmptyDirectory('cache')).toBe(true)
    expect(tree.treeVersion).toBe(version)
    tree.setTree([], false)
    expect(tree.treeVersion).toBeGreaterThan(version)
  })

  it('gitignore置灰不从打包/候选派生数据移除普通文件', () => {
    const tree = useFileTreeStore()
    tree.setTree([{ name: 'frontend', path: 'frontend', kind: 'dir', ignored: true, childrenLoaded: true, children: [
      { name: 'fh2-plugin.json', path: 'frontend/exp_ui/fh2-plugin.json', kind: 'file', ignored: true },
    ] }], false)
    expect(tree.allFiles).toEqual(['frontend/exp_ui/fh2-plugin.json'])
  })

  it('setChildren：不可变写回单层子树，未受影响节点内容不变', () => {
    const tree = useFileTreeStore()
    tree.setTree([dir('node_modules', 'node_modules', [], true), dir('src', 'src', [file('plugin.ts', 'src/plugin.ts')])], false)
    tree.setChildren('node_modules', [dir('left-pad', 'node_modules/left-pad')])
    expect(tree.find('node_modules/left-pad')?.kind).toBe('dir')
    expect((tree.find('node_modules') as { children?: readonly TreeNode[] }).children)
      .toEqual([dir('left-pad', 'node_modules/left-pad')])
    // 未受影响的节点内容不变（pinia 代理包装下按深度比较）
    expect(tree.find('src')).toStrictEqual({ name: 'src', path: 'src', kind: 'dir', children: [file('plugin.ts', 'src/plugin.ts')] })
    // 未知路径 no-op
    tree.setChildren('no-such-dir', [])
    expect(tree.nodes).toHaveLength(2)
  })

  it('firstPreferredFile：manifest 优先，其次 plugin.json，最后首个文件', () => {
    const tree = useFileTreeStore()
    tree.setTree([file('a.ts', 'a.ts'), file('plugin.json', 'plugin.json')], false)
    expect(tree.firstPreferredFile).toBe('plugin.json')
    tree.setTree([dir('sub', 'sub', [file('fh2-plugin.json', 'sub/fh2-plugin.json')]), file('a.ts', 'a.ts')], false)
    expect(tree.firstPreferredFile).toBe('sub/fh2-plugin.json')
    tree.setTree([file('a.ts', 'a.ts')], false)
    expect(tree.firstPreferredFile).toBe('a.ts')
    tree.setTree([], false)
    expect(tree.firstPreferredFile).toBeNull()
  })

  it('toggle 切换折叠，revealParents 展开各级父目录', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, false)
    expect(tree.collapsed).toEqual(new Set(['src', 'src/views']))
    tree.toggle('src')
    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.collapsed.has('src/views')).toBe(true)
    tree.revealParents('src/views/panel.ts')
    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.collapsed.size).toBe(0)
  })

  it('刷新保留已有目录状态，新出现的目录默认折叠', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, false)
    tree.toggle('src')

    tree.setTree([
      dir('src', 'src', [
        dir('views', 'src/views', [file('panel.ts', 'src/views/panel.ts')]),
        dir('new', 'src/new', [file('new.ts', 'src/new/new.ts')]),
      ]),
    ], false)

    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.collapsed.has('src/views')).toBe(true)
    expect(tree.collapsed.has('src/new')).toBe(true)
  })

  it('filesUnder：目录列出深层文件，文件返回自身，未知路径为空', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, false)
    expect(tree.filesUnder('src')).toEqual(['src/views/panel.ts', 'src/plugin.ts'])
    expect(tree.filesUnder('src/plugin.ts')).toEqual(['src/plugin.ts'])
    expect(tree.filesUnder('nope')).toEqual([])
  })

  it('isEmptyDirectory 只对空目录为真', () => {
    const tree = useFileTreeStore()
    tree.setTree([dir('empty', 'empty'), dir('full', 'full', [file('a', 'full/a')]), file('f', 'f')], false)
    expect(tree.isEmptyDirectory('empty')).toBe(true)
    expect(tree.isEmptyDirectory('full')).toBe(false)
    expect(tree.isEmptyDirectory('f')).toBe(false)
    expect(tree.isEmptyDirectory('nope')).toBe(false)
  })

  it('reset 清掉节点、截断标记与折叠记忆', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, true)
    tree.toggle('src')
    tree.reset()
    expect(tree.nodes).toEqual([])
    expect(tree.truncated).toBe(false)
    expect(tree.collapsed.size).toBe(0)
    expect(tree.allFiles).toEqual([])
    expect(tree.editing).toBeNull()
  })

  it('行内新建会展开目标目录，重命名和取消只维护单个会话', () => {
    const tree = useFileTreeStore()
    tree.setTree(TREE, false)
    tree.beginCreate('file', 'src')
    expect(tree.collapsed.has('src')).toBe(false)
    expect(tree.editing).toEqual({ mode: 'create', kind: 'file', base: 'src' })
    tree.beginRename({ path: 'src/plugin.ts', kind: 'file' })
    expect(tree.editing).toEqual({ mode: 'rename', target: { path: 'src/plugin.ts', kind: 'file' } })
    tree.cancelEdit()
    expect(tree.editing).toBeNull()
  })

  it('active 跟随 documents store 的活动文档', async () => {
    const tree = useFileTreeStore()
    const { useDocumentsStore } = await import('./documents.js')
    const documents = useDocumentsStore()
    expect(tree.active).toBeNull()
    documents.open('src/plugin.ts', 'x')
    expect(tree.active).toBe('src/plugin.ts')
  })
})
