<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { useUiStore } from '../../stores/ui'
import EditorEmpty from '../editor/EditorEmpty.vue'
import EditorTabs from '../editor/EditorTabs.vue'
import EditorBreadcrumbs from '../editor/EditorBreadcrumbs.vue'
import MonacoHost from '../editor/MonacoHost.vue'
import WorkflowPane from '../../features/workflow/components/WorkflowPane.vue'

const ui = useUiStore()
</script>

<template>
  <div class="ide-main">
    <div class="view view-editor" :class="[{ active: ui.view === 'editor' }]">
      <EditorTabs />
      <EditorBreadcrumbs />
      <div class="editor-host">
        <MonacoHost />
        <EditorEmpty />
      </div>
    </div>
    <WorkflowPane />
  </div>
</template>
