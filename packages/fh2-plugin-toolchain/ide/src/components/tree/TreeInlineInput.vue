<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, nextTick, onMounted, ref } from 'vue'
import { DocumentOutline, FolderOutline } from '@vicons/ionicons5'
import { useIdeContext } from '../../composables/use-ide'
import { useFileTreeStore } from '../../stores/file-tree'
import type { TreeEditSession } from '../../stores/file-tree'

const props = defineProps<{
  session: TreeEditSession
  depth: number
}>()

const ide = useIdeContext()
const tree = useFileTreeStore()
const input = ref<HTMLInputElement | null>(null)
const pending = ref(false)
const value = ref(props.session.mode === 'rename'
  ? props.session.target.path.split('/').at(-1) ?? props.session.target.path
  : '')
const kind = computed(() => props.session.mode === 'rename' ? props.session.target.kind : props.session.kind)

/** Escape 取消后组件被 v-if 移除时浏览器会派发 blur→confirm：取消路径不得落盘。 */
let cancelled = false

onMounted(() => {
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
})

async function confirm (): Promise<void> {
  if (pending.value || cancelled) return
  pending.value = true
  // 空名与非法名统一交给 create/rename 内部校验拒绝（状态栏报错 + 保留输入框），
  // 不再静默取消 —— 用户敲了回车却看到输入框无声消失，不知道发生了什么。
  const succeeded = props.session.mode === 'create'
    ? await ide.createTreeEntry(props.session.kind, props.session.base, value.value.trim())
    : await ide.renameTreeEntry(props.session.target, value.value.trim())
  pending.value = false
  if (succeeded) tree.cancelEdit()
  else input.value?.focus()
}

function cancel (): void {
  if (!pending.value) {
    cancelled = true
    tree.cancelEdit()
  }
}
function keydown (event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void confirm()
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
}
</script>

<template>
  <div
    class="tree-row tree-inline-row"
    :style="{ paddingLeft: `${8 + depth * 14 + (kind === 'file' ? 14 : 0)}px` }"
  >
    <component :is="kind === 'dir' ? FolderOutline : DocumentOutline" class="tree-icon tree-inline-icon" />
    <input
      ref="input"
      v-model="value"
      class="tree-inline-input"
      :disabled="pending"
      :aria-label="kind === 'dir' ? '目录名' : '文件名'"
      @keydown="keydown"
      @blur="void confirm()"
      @click.stop
      @contextmenu.stop
    >
  </div>
</template>
