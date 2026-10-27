<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, ref } from 'vue'
import { WorkflowCanvas } from '../canvas/workflow-canvas.js'
import { useWorkflowStore } from '../store.js'

/**
 * 画布宿主：SVG 交互与渲染留在命令式 WorkflowCanvas（同 Monaco 的待遇），
 * 回调与重绘由 workflow store 驱动。
 */
const workflow = useWorkflowStore()
const host = ref<HTMLElement | null>(null)

onMounted(() => {
  if (host.value === null) return
  const canvas = new WorkflowCanvas(host.value, {
    onSelect: nodeId => workflow.select(nodeId),
    onNodeContextMenu: (nodeId, x, y) => workflow.showNodeMenu(nodeId, x, y),
    onBlankContextMenu: (x, y) => workflow.showBlankMenu(x, y),
    onConnect: (from, to) => workflow.requestConnect(from, to),
    onEdgeContextMenu: (from, to, x, y) => workflow.showEdgeMenu(from, to, x, y),
    onDropAction: (action, upstream, scriptId) => void workflow.createStep(action, upstream, scriptId),
  })
  workflow.attachCanvas(canvas)
})
</script>

<template>
  <div id="wf-canvas" ref="host" class="wf-canvas" />
</template>
