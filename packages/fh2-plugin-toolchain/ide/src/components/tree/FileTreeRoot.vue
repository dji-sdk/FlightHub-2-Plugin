<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useDroppable } from '@dnd-kit/vue'
import { useIdeContext } from '../../composables/use-ide'
import { useFileTreeStore } from '../../stores/file-tree'
import FileTreeNode from './FileTreeNode.vue'
import TreeInlineInput from './TreeInlineInput.vue'

/**
 * 文件树容器：数据与折叠记忆在 file-tree store。
 * 空白处右键等价于对工作根操作。
 * 活动文档（切 tab、跳转等）变化时展开其父目录并滚动到该行（对齐 VSCode
 * autoReveal）：nearest 保证行已在视口内时零滚动，高频切 tab 不抖动。
 */
const ide = useIdeContext()
const tree = useFileTreeStore()
const rootNodes = computed(() => tree.nodes)
const root = ref<HTMLElement | null>(null)
const { isDropTarget } = useDroppable({
  id: 'tree-root',
  element: root,
  data: { destination: '' },
})

/** 挂载时活动文档可能早于本组件存在（先在搜索面板打开再切回文件树）。 */
async function revealActiveFile (path: string | null): Promise<void> {
  if (path === null) return
  tree.revealParents(path)
  await nextTick()
  root.value
    ?.querySelector(`[data-kind="file"][data-path="${CSS.escape(path)}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

watch(() => tree.active, path => void revealActiveFile(path))
onMounted(() => void revealActiveFile(tree.active))
</script>

<template>
  <div
    ref="root"
    class="ide-file-tree"
    :class="{ 'tree-drop-target': isDropTarget }"
    @contextmenu.prevent.stop="ide.showTreeMenu(null, $event.clientX, $event.clientY)"
  >
    <TreeInlineInput
      v-if="tree.editing?.mode === 'create' && tree.editing.base === ''"
      :session="tree.editing"
      :depth="0"
    />
    <div v-if="rootNodes.length === 0 && tree.editing === null" class="tree-empty">
      工作区为空
    </div>
    <template v-else>
      <FileTreeNode
        v-for="node in rootNodes"
        :key="node.path"
        :node="node"
        :depth="0"
      />
      <div v-if="tree.truncated" class="tree-truncated">
        文件树已截断（超出节点上限）
      </div>
    </template>
  </div>
</template>
