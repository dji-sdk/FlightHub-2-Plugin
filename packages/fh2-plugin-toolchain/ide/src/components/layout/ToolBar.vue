<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { BuildOutline, CheckmarkCircleOutline, EllipsisHorizontalOutline, EyeOutline, PlayOutline, StopCircle } from '@vicons/ionicons5'
import { NButton, NDropdown, NIcon } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { computed, h, reactive } from 'vue'
import { useIdeContext } from '../../composables/use-ide'
import { useRunStore } from '../../stores/run'
import { useUiStore } from '../../stores/ui'
import type { IdeView } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'

/** 顶部工具栏：工作区信息、视图 Tab、运行与能力层命令。保存走 Ctrl/Cmd+S，打包含构建。 */
const ide = useIdeContext()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const run = useRunStore()
/** 运行/停止的点击反馈：toggleRun 跨过弹窗与启动请求，期间给按钮 loading。 */
const runPending = reactive({ dev: false, preview: false })

const views: readonly { readonly key: IdeView, readonly label: string }[] = [
  { key: 'editor', label: '编辑器' },
  { key: 'workflow', label: '工作流' },
]

function runButtonLabel (mode: 'dev' | 'preview'): string {
  const active = run.isActive(mode)
  if (runPending[mode]) return active ? '停止中…' : '启动中…'
  if (mode === 'dev') return active ? '停止' : '运行'
  return active ? '停止预览' : '预览'
}

async function toggleRun (mode: 'dev' | 'preview'): Promise<void> {
  if (runPending[mode]) return
  runPending[mode] = true
  try {
    await ide.toggleRun(mode)
  } finally {
    runPending[mode] = false
  }
}

function renderIcon (icon: typeof PlayOutline) {
  return () => h(NIcon, null, { default: () => h(icon) })
}

const moreOptions = computed<DropdownOption[]>(() => [
  {
    key: 'preview',
    label: runButtonLabel('preview'),
    disabled: runPending.preview,
    icon: renderIcon(run.isActive('preview') ? StopCircle : EyeOutline),
    props: { id: 'btn-run-preview-menu' },
  },
  {
    key: 'validate',
    label: ui.busy === 'validate' ? '检查中…' : '检查工程',
    disabled: ui.busy !== null,
    icon: renderIcon(CheckmarkCircleOutline),
    props: { id: 'btn-validate-menu' },
  },
  {
    key: 'pack',
    label: ui.busy === 'pack' ? '打包中…' : '打包',
    disabled: ui.busy !== null,
    icon: renderIcon(BuildOutline),
    props: { id: 'btn-pack-menu' },
  },
])

function onMoreSelect (key: string): void {
  if (key === 'preview') void toggleRun('preview')
  if (key === 'validate') void ide.runValidate()
  if (key === 'pack') void ide.runPack()
}

function switchTo (view: IdeView): void {
  void ide.switchView(view)
}
</script>

<template>
  <div class="toolbar">
    <span class="toolbar-logo">司空插件 Web IDE</span>
    <span
      v-if="workspace.info !== null"
      class="toolbar-workspace"
      :title="`${workspace.info.root}（toolchain ${workspace.info.toolchainVersion}）`"
    >
      <span>{{ workspace.info.name }}</span>
      <span class="kind">{{ workspace.info.kind }}</span>
    </span>

    <div class="view-tabs">
      <button
        v-for="view in views"
        :id="`view-tab-${view.key}`"
        :key="view.key"
        type="button"
        class="view-tab" :class="[{ active: ui.view === view.key }]"
        @click="switchTo(view.key)"
      >
        {{ view.label }}
      </button>
    </div>

    <span class="toolbar-spacer" />

    <NButton
      id="btn-run-dev"
      quaternary
      size="small"
      class="toolbar-action"
      :class="[{ running: run.isActive('dev') }]"
      :loading="runPending.dev"
      :title="run.isActive('dev') ? '停止 dev 进程' : '运行 dev 进程'"
      @click="void toggleRun('dev')"
    >
      <template #icon>
        <NIcon :component="run.isActive('dev') ? StopCircle : PlayOutline" />
      </template>
      <span class="btn-label">{{ runButtonLabel('dev') }}</span>
    </NButton>

    <NButton
      id="btn-run-preview"
      quaternary
      size="small"
      class="toolbar-action toolbar-secondary"
      :class="[{ running: run.isActive('preview') }]"
      :loading="runPending.preview"
      title="预览插件"
      @click="void toggleRun('preview')"
    >
      <template #icon>
        <NIcon :component="run.isActive('preview') ? StopCircle : EyeOutline" />
      </template>
      <span class="btn-label">{{ runButtonLabel('preview') }}</span>
    </NButton>
    <NButton
      id="btn-validate"
      quaternary
      size="small"
      class="toolbar-action toolbar-secondary"
      :disabled="ui.busy !== null && ui.busy !== 'validate'"
      :loading="ui.busy === 'validate'"
      title="保存全部改动后检查工程"
      @click="void ide.runValidate()"
    >
      <template #icon>
        <NIcon :component="CheckmarkCircleOutline" />
      </template>
      <span class="btn-label">{{ ui.busy === 'validate' ? '检查中…' : '检查工程' }}</span>
    </NButton>
    <NButton
      id="btn-pack"
      quaternary
      size="small"
      class="toolbar-action toolbar-secondary"
      :disabled="ui.busy !== null && ui.busy !== 'pack'"
      :loading="ui.busy === 'pack'"
      title="生成上传包（含构建与类型检查）"
      @click="void ide.runPack()"
    >
      <template #icon>
        <NIcon :component="BuildOutline" />
      </template>
      <span class="btn-label">{{ ui.busy === 'pack' ? '打包中…' : '打包' }}</span>
    </NButton>

    <NDropdown trigger="click" :options="moreOptions" @select="onMoreSelect">
      <NButton id="ide-more" quaternary size="small" class="toolbar-more" title="更多操作">
        <template #icon>
          <NIcon :component="EllipsisHorizontalOutline" />
        </template>
      </NButton>
    </NDropdown>
  </div>
</template>
