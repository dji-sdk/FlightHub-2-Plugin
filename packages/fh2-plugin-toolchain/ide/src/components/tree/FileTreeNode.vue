<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, ref, watch } from 'vue'
import { useDraggable, useDroppable } from '@dnd-kit/vue'
import { ChevronForwardOutline } from '@vicons/ionicons5'
import { useIdeContext } from '../../composables/use-ide'
import { useFileTreeStore } from '../../stores/file-tree'
import type { TreeContextTarget } from '../../stores/file-tree'
import type { TreeNode } from '../../api/types'
import { TREE_FOLDER_ICONS, fileIconOf } from './tree-icons'
import TreeInlineInput from './TreeInlineInput.vue'

/**
 * 文件树行：目录可折叠（状态在 file-tree store），文件点击打开。
 * 图标按类型着色（tree-icons.ts），目录随折叠态切换开/合图标。
 * 模板内自引用 FileTreeNode 实现递归（Vue SFC 按文件名隐式自引用）。
 */
const props = defineProps<{
  node: TreeNode
  depth: number
}>()

const ide = useIdeContext()
const tree = useFileTreeStore()
const row = ref<HTMLElement | null>(null)

const collapsed = computed(() => tree.collapsed.has(props.node.path))
const fileIcon = computed(() =>
  props.node.kind === 'file' ? fileIconOf(props.node.name) : null)
const folderIcon = computed(() =>
  collapsed.value ? TREE_FOLDER_ICONS.folder : TREE_FOLDER_ICONS.folderOpen)
const isRenaming = computed(() =>
  tree.editing?.mode === 'rename' && tree.editing.target.path === props.node.path)
const isCreatingChild = computed(() =>
  props.node.kind === 'dir' && tree.editing?.mode === 'create' && tree.editing.base === props.node.path)
/** 加载状态与置灰属性独立，普通子目录也能继续展开。 */
const needsLazyLoad = computed(() =>
  tree.needsChildren(props.node.path))

watch([collapsed, () => props.node], () => {
  if (!collapsed.value && needsLazyLoad.value) void ide.loadTreeChildren(props.node.path)
}, { immediate: true })

function toggleDir (path: string): void {
  if (needsLazyLoad.value && tree.collapsed.has(path)) {
    // 展开未加载的生成目录：拉单层子树，写回后直接展开（用户点的是“展开”）
    tree.toggle(path)
    void ide.loadTreeChildren(path)
    return
  }
  tree.toggle(path)
}

const { isDragging } = useDraggable({
  id: computed(() => `tree-node:${props.node.path}`),
  element: row,
  data: computed(() => ({ path: props.node.path, kind: props.node.kind })),
  disabled: computed(() => tree.editing !== null),
})
const { isDropTarget } = useDroppable({
  id: computed(() => `tree-dir:${props.node.path}`),
  element: row,
  data: computed(() => ({ destination: props.node.path })),
  disabled: computed(() => props.node.kind !== 'dir' || tree.editing !== null),
})

function menu (target: TreeContextTarget, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  ide.showTreeMenu(target, event.clientX, event.clientY)
}

function rename (event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  tree.beginRename({ path: props.node.path, kind: props.node.kind })
}
</script>

<template>
  <template v-if="node.kind === 'dir'">
    <TreeInlineInput v-if="isRenaming && tree.editing !== null" :session="tree.editing" :depth="depth" />
    <div
      v-else
      ref="row"
      class="tree-row tree-dir" :class="[{ 'tree-dragging': isDragging, 'tree-drop-target': isDropTarget, 'tree-generated': node.generated === true }]"
      :data-ignored="node.ignored === true ? 'true' : undefined"
      :aria-busy="tree.loading.has(node.path)"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      :data-path="node.path"
      data-kind="dir"
      tabindex="0"
      @click="toggleDir(node.path)"
      @keydown.f2="rename"
      @contextmenu="menu({ path: node.path, kind: 'dir' }, $event)"
    >
      <ChevronForwardOutline class="tree-chevron" :class="[{ collapsed }]" />
      <component :is="folderIcon.component" class="tree-icon" :class="[folderIcon.cls]" />
      <span class="tree-name">{{ node.name }}</span>
    </div>
    <template v-if="!collapsed">
      <TreeInlineInput
        v-if="isCreatingChild && tree.editing !== null"
        :session="tree.editing"
        :depth="depth + 1"
      />
      <FileTreeNode
        v-for="child in node.children ?? []"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
      />
    </template>
  </template>
  <TreeInlineInput v-else-if="isRenaming && tree.editing !== null" :session="tree.editing" :depth="depth" />
  <div
    v-else
    ref="row"
    class="tree-row tree-file"
    :class="[{ 'active': node.path === tree.active, 'tree-dragging': isDragging, 'tree-generated': node.generated === true }]"
    :data-ignored="node.ignored === true ? 'true' : undefined"
    :style="{ paddingLeft: `${8 + depth * 14 + 14}px` }"
    :data-path="node.path"
    data-kind="file"
    tabindex="0"
    @click="void ide.openFile(node.path)"
    @keydown.f2="rename"
    @contextmenu="menu({ path: node.path, kind: 'file' }, $event)"
  >
    <component
      :is="fileIcon.component"
      v-if="fileIcon !== null"
      class="tree-icon" :class="[fileIcon.cls]"
    />
    <span class="tree-name">{{ node.name }}</span>
  </div>
</template>
