<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { DragDropProvider, KeyboardSensor, PointerSensor } from '@dnd-kit/vue'
import { PointerActivationConstraints } from '@dnd-kit/dom'
import { ref } from 'vue'
import type { DragEndEvent } from '@dnd-kit/vue'
import { useIdeContext } from '../../composables/use-ide'
import type { TreeContextTarget } from '../../stores/file-tree'
import FileTreeRoot from './FileTreeRoot.vue'

/**
 * 文件树容器：数据与折叠记忆在 file-tree store。
 * 空白处右键等价于对工作根操作。
 */
const ide = useIdeContext()
// 只配置文件树自己的鼠标传感器，不影响其他画布及触摸默认策略。
const sensors = [PointerSensor.configure({ activationConstraints: (event, source) => {
  if (event.pointerType === 'mouse') return [new PointerActivationConstraints.Distance({ value: 8 })]
  const defaults = PointerSensor.defaults.activationConstraints
  return typeof defaults === 'function' ? defaults(event, source) : defaults
} }), KeyboardSensor]
const suppressClick = ref(false)
function finishDrag (event: DragEndEvent): void {
  suppressClick.value = true
  window.setTimeout(() => {
    suppressClick.value = false
  }, 0)
  onDragEnd(event)
}
function captureClick (event: MouseEvent): void {
  if (!suppressClick.value) return
  event.preventDefault()
  event.stopPropagation()
}

function onDragEnd (event: DragEndEvent): void {
  if (event.canceled) return
  const source = event.operation.source?.data as TreeContextTarget | undefined
  const destination = event.operation.target?.data.destination as string | undefined
  if (source === undefined || destination === undefined) return
  void ide.moveTreeEntry(source, destination)
}
</script>

<template>
  <DragDropProvider :sensors="sensors" @drag-end="finishDrag">
    <div class="file-tree-container" @click.capture="captureClick">
      <FileTreeRoot />
    </div>
  </DragDropProvider>
</template>
