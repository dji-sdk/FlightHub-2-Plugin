// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 SZ DJI Technology Co., Ltd.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { TreeNode } from '../api/types.js'
import { useDocumentsStore } from './documents.js'

export interface TreeContextTarget {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

export type TreeEditSession =
  | { readonly mode: 'create'; readonly kind: 'file' | 'dir'; readonly base: string }
  | { readonly mode: 'rename'; readonly target: TreeContextTarget }

function walk (nodes: readonly TreeNode[], visit: (node: TreeNode) => void, skipGenerated = false): void {
  for (const node of nodes) {
    visit(node)
    if (node.kind === 'dir') {
      if (skipGenerated && node.generated === true) continue
      walk(node.children ?? [], visit, skipGenerated)
    }
  }
}

/**
 * 文件树数据与纯查询。渲染（行 DOM、点击、右键）在 UI 层，
 * 折叠状态按目录 path 记忆，刷新树（SSE）后仍然保持。
 */
export const useFileTreeStore = defineStore('file-tree', () => {
  const documents = useDocumentsStore()

  const nodes = ref<readonly TreeNode[]>([])
  const truncated = ref(false)
  const collapsed = ref(new Set<string>())
  const editing = ref<TreeEditSession | null>(null)
  const treeVersion = ref(0)
  const loading = ref(new Set<string>())
  /**
   * 已经在树里出现过的目录。只用 `collapsed` 无法区分“用户主动展开”和
   * “刷新后刚出现、尚未操作”，因此单独保留这个集合。
   */
  let knownDirectories = new Set<string>()

  /** 高亮跟随当前活动文档，不单独维护。 */
  const active = computed(() => documents.active)

  /**
   * 源码文件全集（跳过生成目录的子树）：搜索面板、工作流候选、
   * 首选文件与打包成员推导共用，node_modules/dist 内容不进派生数据。
   */
  const allFiles = computed(() => {
    const files: string[] = []
    walk(nodes.value, (node) => {
      if (node.kind === 'file') files.push(node.path)
    }, true)
    return files
  })

  const allDirectories = computed(() => {
    const dirs: string[] = []
    walk(nodes.value, (node) => {
      if (node.kind === 'dir') dirs.push(node.path)
    }, true)
    return dirs
  })

  /** 首屏优先打开的文件：manifest 优先，其次任意文本文件。 */
  const firstPreferredFile = computed(() => {
    const files = allFiles.value
    return files.find(path => path.endsWith('fh2-plugin.json'))
      ?? files.find(path => path.endsWith('plugin.json'))
      ?? files[0]
      ?? null
  })

  function setTree (next: readonly TreeNode[], isTruncated: boolean): void {
    treeVersion.value += 1
    loading.value = new Set()
    updateTree(next, isTruncated)
  }

  function updateTree (next: readonly TreeNode[], isTruncated: boolean): void {
    const nextDirectories = directoryPaths(next)
    const nextCollapsed = new Set([...collapsed.value].filter(path => nextDirectories.has(path)))
    // 新目录一律从折叠态出现；已有目录沿用用户在刷新前的展开/折叠选择。
    for (const path of nextDirectories) {
      if (!knownDirectories.has(path)) nextCollapsed.add(path)
    }
    nodes.value = next
    truncated.value = isTruncated
    collapsed.value = nextCollapsed
    knownDirectories = nextDirectories
  }

  /** 工作区切换时连折叠状态一起丢掉，否则新工作区会继承旧路径的折叠记忆。 */
  function reset (): void {
    treeVersion.value += 1
    loading.value = new Set()
    nodes.value = []
    truncated.value = false
    collapsed.value = new Set()
    knownDirectories = new Set()
    editing.value = null
  }

  function beginCreate (kind: 'file' | 'dir', base: string): void {
    editing.value = { mode: 'create', kind, base }
    if (base !== '') collapsed.value.delete(base)
  }

  function beginRename (target: TreeContextTarget): void {
    editing.value = { mode: 'rename', target }
  }

  function cancelEdit (): void {
    editing.value = null
  }

  function toggle (path: string): void {
    if (collapsed.value.has(path)) collapsed.value.delete(path)
    else collapsed.value.add(path)
  }

  /** 展开路径的各级父目录：新建/重命名后定位新条目、活动文档变化时 reveal 都走这里。 */
  function revealParents (path: string): void {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i += 1) collapsed.value.delete(segments.slice(0, i).join('/'))
  }

  function find (path: string): TreeNode | null {
    let hit: TreeNode | null = null
    walk(nodes.value, (node) => {
      if (hit === null && node.path === path) hit = node
    })
    return hit
  }

  /** 目录下（含深层）的文件路径，用于删除前列清单。 */
  function filesUnder (path: string): readonly string[] {
    const node = find(path)
    if (node === null) return []
    if (node.kind === 'file') return [node.path]
    const files: string[] = []
    walk(node.children ?? [], (child) => {
      if (child.kind === 'file') files.push(child.path)
    })
    return files
  }

  /**
   * 目录是否为空 —— 删除确认要据此决定是否强制要求勾「递归」。
   * 生成目录的 children 未加载（空数组 ≠ 空目录）：按「非空」处理，
   * 由删除确认文案兜底（内容未展开时按包含全部内容处理）。
   */
  function isEmptyDirectory (path: string): boolean {
    const node = find(path)
    return node !== null && node.kind === 'dir' && !needsChildren(path) && (node.children ?? []).length === 0
  }

  function needsChildren (path: string): boolean {
    const node = find(path)
    return node !== null && node.kind === 'dir' && (node.childrenLoaded === false || (node.childrenLoaded === undefined && node.generated === true && (node.children ?? []).length === 0))
  }

  function setLoading (path: string, value: boolean): void {
    if (value) loading.value.add(path)
    else loading.value.delete(path)
  }

  /** 生成目录（或任意目录）展开时惰性写入单层子树；不可变重建触发响应式。 */
  function setChildren (path: string, children: readonly TreeNode[]): void {
    const rebuild = (list: readonly TreeNode[]): readonly TreeNode[] | null => {
      let changed: TreeNode[] | null = null
      for (let index = 0; index < list.length; index += 1) {
        const node = list[index]!
        if (node.path === path) {
          changed = [...list.slice(0, index), { ...node, children, childrenLoaded: true } as TreeNode, ...list.slice(index + 1)]
          break
        }
        if (node.kind === 'dir') {
          const rebuilt = rebuild(node.children ?? [])
          if (rebuilt !== null) {
            changed = [...list.slice(0, index), { ...node, children: rebuilt }, ...list.slice(index + 1)]
            break
          }
        }
      }
      return changed
    }
    const next = rebuild(nodes.value)
    if (next !== null) updateTree(next, truncated.value)
  }

  return {
    nodes,
    truncated,
    collapsed,
    editing,
    treeVersion,
    loading,
    needsChildren,
    setLoading,
    active,
    allFiles,
    allDirectories,
    firstPreferredFile,
    setTree,
    reset,
    toggle,
    beginCreate,
    beginRename,
    cancelEdit,
    revealParents,
    find,
    filesUnder,
    isEmptyDirectory,
    setChildren,
  }
})

function directoryPaths (nodes: readonly TreeNode[]): Set<string> {
  const directories = new Set<string>()
  walk(nodes, (node) => {
    if (node.kind === 'dir') directories.add(node.path)
  })
  return directories
}
