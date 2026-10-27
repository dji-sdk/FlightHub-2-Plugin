<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NConfigProvider, darkTheme } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import { computed, onMounted } from 'vue'
import { Pane, Splitpanes } from 'splitpanes'
import type { SplitpanesResizedPayload } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'
import { useIde } from './composables/use-ide'
import ConflictDialog from './components/conflicts/ConflictDialog.vue'
import RecoveryDialog from './components/conflicts/RecoveryDialog.vue'
import DialogHost from './components/common/DialogHost.vue'
import FatalOverlay from './components/common/FatalOverlay.vue'
import BottomPanel from './components/layout/BottomPanel.vue'
import IdeBody from './components/layout/IdeBody.vue'
import StatusBar from './components/layout/StatusBar.vue'
import ToolBar from './components/layout/ToolBar.vue'
import { useUiStore } from './stores/ui'
import './styles.css'

const ide = useIde()
const ui = useUiStore()

/** 与 styles.css 的 vs-dark 色板对齐，避免 Naive 控件在暗色界面里发白。 */
const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#007acc',
    primaryColorHover: '#1a8ad4',
    primaryColorPressed: '#0062a3',
    bodyColor: '#1e1e1e',
    cardColor: '#252526',
    modalColor: '#252526',
    popoverColor: '#2d2d2d',
    inputColor: '#3c3c3c',
    borderColor: '#3c3c3c',
    textColorBase: '#cccccc',
    borderRadius: '4px',
    borderRadiusSmall: '3px',
    heightSmall: '26px',
    heightMedium: '30px',
    fontSizeSmall: '12px',
    fontSizeMedium: '12px',
  },
  Button: {
    heightTiny: '22px',
    heightSmall: '26px',
    borderRadiusTiny: '3px',
    borderRadiusSmall: '3px',
    // Naive 暗色主题的 baseColor 是 #000，主/语义按钮默认会变成黑字。
    textColorPrimary: '#ffffff',
    textColorHoverPrimary: '#ffffff',
    textColorPressedPrimary: '#ffffff',
    textColorFocusPrimary: '#ffffff',
    textColorDisabledPrimary: 'rgba(255, 255, 255, 0.55)',
    textColorInfo: '#ffffff',
    textColorHoverInfo: '#ffffff',
    textColorPressedInfo: '#ffffff',
    textColorFocusInfo: '#ffffff',
    textColorSuccess: '#ffffff',
    textColorHoverSuccess: '#ffffff',
    textColorPressedSuccess: '#ffffff',
    textColorFocusSuccess: '#ffffff',
    textColorWarning: '#ffffff',
    textColorHoverWarning: '#ffffff',
    textColorPressedWarning: '#ffffff',
    textColorFocusWarning: '#ffffff',
    textColorError: '#ffffff',
    textColorHoverError: '#ffffff',
    textColorPressedError: '#ffffff',
    textColorFocusError: '#ffffff',
  },
  Tabs: {
    tabFontSizeSmall: '12px',
  },
}

const mainSize = computed(() => Math.max(25, 100 - ui.panelSizePct))

/** 拖完分割线把面板比例存进 store：折叠再展开不丢用户拖过的位置。 */
function onPanelResized (payload: SplitpanesResizedPayload): void {
  const panelPane = payload.panes.at(-1)
  if (panelPane === undefined) return
  ui.panelSizePct = Math.round(panelPane.size * 100) / 100
}

onMounted(() => {
  ide.start()
})
</script>

<template>
  <NConfigProvider :theme="darkTheme" :theme-overrides="themeOverrides">
    <div class="ide">
      <ToolBar />
      <!-- 展开态：主体 / 底部面板 横向分割（含终端拖拽调高） -->
      <Splitpanes
        v-if="!ui.panelCollapsed"
        horizontal
        class="default-theme fh2-split fh2-split-horizontal"
        @resized="onPanelResized"
      >
        <Pane :size="mainSize" :min-size="25">
          <IdeBody />
        </Pane>
        <Pane :size="ui.panelSizePct" :min-size="10" :max-size="75">
          <BottomPanel />
        </Pane>
      </Splitpanes>
      <!-- 折叠态：30px 精确条 + 主体占满（splitpanes 的百分比语义表达不了精确像素） -->
      <template v-else>
        <IdeBody />
        <BottomPanel />
      </template>
      <StatusBar />
      <FatalOverlay />
      <ConflictDialog />
      <RecoveryDialog />
    </div>
    <DialogHost />
  </NConfigProvider>
</template>
