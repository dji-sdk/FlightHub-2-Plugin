<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="settings-panel" data-plugin-view="capture-settings">
    <div class="panel-header">
      <div class="tabs">
        <button class="tab" type="button" :class="{ active: activeTab === 'capture' }" data-testid="settings-tab-capture" @click="setActiveTab('capture')">交通违章抓拍</button>
        <button class="tab" type="button" :class="{ active: activeTab === 'alert' }" data-testid="settings-tab-alert" @click="setActiveTab('alert')">告警</button>
      </div>
      <button class="close" type="button" title="关闭" @click="close">×</button>
    </div>
    <div class="panel-body">
      <template v-if="activeTab === 'capture'">
        <div class="switch-row" :data-disabled="personRoadDisabled">
          <div class="switch-label">
            <span>行人上路抓拍</span>
            <button class="info"
                    type="button"
                    aria-label="行人上路抓拍说明"
                    aria-describedby="capture-settings-tooltip"
                    @mouseenter="showTooltip('person', $event)"
                    @mouseleave="hideTooltip"
                    @focus="showTooltip('person', $event)"
                    @blur="hideTooltip">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" /><path d="M8 7v4M8 4.5v.1" /></svg>
            </button>
          </div>
          <button class="switch"
                  type="button"
                  role="switch"
                  :aria-checked="state.personRoad.enabled"
                  :data-enabled="state.personRoad.enabled"
                  :disabled="personRoadDisabled"
                  data-testid="person-road-switch"
                  @click="togglePersonRoad">
            <span class="knob" />
          </button>
        </div>
        <p v-if="!state.personRoad.enabled && state.personRoad.disabledReason" class="reason" data-testid="person-road-block-reason">
          {{ state.personRoad.disabledReason }}
        </p>

        <div class="switch-row" :data-disabled="laneChangeDisabled">
          <div class="switch-label">
            <span>违章变道抓拍</span>
            <button class="info"
                    type="button"
                    aria-label="违章变道抓拍说明"
                    aria-describedby="capture-settings-tooltip"
                    @mouseenter="showTooltip('lane-change', $event)"
                    @mouseleave="hideTooltip"
                    @focus="showTooltip('lane-change', $event)"
                    @blur="hideTooltip">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" /><path d="M8 7v4M8 4.5v.1" /></svg>
            </button>
          </div>
          <button class="switch"
                  type="button"
                  role="switch"
                  :aria-checked="state.laneChange.enabled"
                  :data-enabled="state.laneChange.enabled"
                  :disabled="laneChangeDisabled"
                  data-testid="lane-change-switch"
                  @click="toggleLaneChange">
            <span class="knob" />
          </button>
        </div>
        <p v-if="!state.laneChange.enabled && state.laneChange.disabledReason" class="reason" data-testid="lane-change-block-reason">
          {{ state.laneChange.disabledReason }}
        </p>
      </template>

      <template v-else>
        <div class="alert-config-card">
          <div class="alert-config-row">
            <div class="alert-config-title">告警通知</div>
            <button class="switch"
                    type="button"
                    role="switch"
                    :aria-checked="state.alert.enabled"
                    :data-enabled="state.alert.enabled"
                    data-testid="alert-enabled-switch"
                    @click="toggleAlertEnabled">
              <span class="knob" />
            </button>
          </div>
          <div class="alert-config-row">
            <button class="option" type="button" role="checkbox" :aria-checked="state.alert.popup" :data-checked="state.alert.popup" :disabled="!state.alert.enabled" data-testid="alert-popup-option" @click="toggleAlertPopup">
              <span class="checkbox"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3.2 7.2 2.3 2.3 5.2-5.2" /></svg></span>
              <span>弹窗通知</span>
            </button>
          </div>
          <div class="alert-config-row">
            <button class="option" type="button" role="checkbox" :aria-checked="state.alert.sound" :data-checked="state.alert.sound" :disabled="!state.alert.enabled" data-testid="alert-sound-option" @click="toggleAlertSound">
              <span class="checkbox"><svg viewBox="0 0 14 14" aria-hidden="true"><path d="m3.2 7.2 2.3 2.3 5.2-5.2" /></svg></span>
              <span>音效</span>
            </button>
          </div>
        </div>
      </template>
    </div>
    <Teleport :to="overlayElement">
      <div v-if="tooltip" id="capture-settings-tooltip" class="tooltip" role="tooltip" :style="tooltip.style">
        <template v-if="tooltip.kind === 'person'">
          开启后在识别到行人时自动跟踪抓拍违规上路行为；请先飞至目标区稳定悬停。
        </template>
        <div v-else class="tooltip-list">
          <div>1. 请先将无人机飞至目标区域并稳定悬停</div>
          <div>2. 您可在直播画面中编辑实线、导流区等</div>
          <div>3. 系统将自动抓拍范围内违规变道的车辆</div>
          <div>4. 建议高度 20 米以内，避免测距不准或风扰晃动导致标注偏移。</div>
          <div>5. 开启前请将画面中心对准无车路面，避免激光打到车身导致高度错误。</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { CaptureSettingsClient, CaptureSettingsState } from './contract'
import { resolveTooltipPosition } from './tooltip-position'

const props = defineProps<{ client: CaptureSettingsClient; overlayElement: HTMLElement }>()
const state = shallowRef<CaptureSettingsState>({
  laneChange: { enabled: false, canEnable: false, disabledReason: null },
  personRoad: { enabled: false, canEnable: false, disabledReason: null },
  switchBusy: false,
  alert: { enabled: true, popup: true, sound: true },
})
const activeTab = shallowRef<'capture' | 'alert'>('capture')
const tooltip = shallowRef<{
  kind: 'person' | 'lane-change';
  style: { left: string; top: string };
} | null>(null)
let subscription: Disposable | undefined

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    state.value = value
  })
})
onUnmounted(() => subscription?.dispose())

/** 原生规则：阻断且未开启时置灰；开启后即使条件变化仍可关。 */
const personRoadDisabled = computed(() => (
  state.value.switchBusy || (!state.value.personRoad.canEnable && !state.value.personRoad.enabled)
))
const laneChangeDisabled = computed(() => (
  state.value.switchBusy || (!state.value.laneChange.canEnable && !state.value.laneChange.enabled)
))

/** 开关失败已由 Controller 统一 toast；UI 侧只消费拒绝，避免 unhandled rejection。 */
function togglePersonRoad (): void {
  void props.client.setPersonRoadEnabled({ enabled: !state.value.personRoad.enabled }).catch(() => {})
}
function toggleLaneChange (): void {
  void props.client.setLaneChangeEnabled({ enabled: !state.value.laneChange.enabled }).catch(() => {})
}
function toggleAlertEnabled (): void {
  props.client.setAlertEnabled({ enabled: !state.value.alert.enabled })
}
function toggleAlertPopup (): void {
  props.client.setAlertPopup({ popup: !state.value.alert.popup })
}
function toggleAlertSound (): void {
  props.client.setAlertSound({ sound: !state.value.alert.sound })
}
function setActiveTab (tab: 'capture' | 'alert'): void {
  tooltip.value = null
  activeTab.value = tab
}
function showTooltip (kind: 'person' | 'lane-change', event: Event): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const overlayRect = props.overlayElement.getBoundingClientRect()
  const position = resolveTooltipPosition(rect, overlayRect, window.innerWidth)
  tooltip.value = {
    kind,
    style: {
      left: `${position.left}px`,
      top: `${position.top}px`,
    },
  }
}
function hideTooltip (): void {
  tooltip.value = null
}
function close (): void {
  hideTooltip()
  props.client.close()
}
</script>

<style scoped>
/* 样式对齐原生 AutoCaptureSettingPanel（违停巡逻设置弹层）：
   #161616 弹层底 + 40px 下划线式 tab 头；外框（边框/圆角/阴影）由宿主 Popover 容器提供。 */
* { box-sizing: border-box; }
.settings-panel { display: flex; width: 280px; flex-direction: column; overflow: hidden; background: #161616; color: #fff; font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif; border-radius: 8px; }
.panel-header { display: flex; align-items: center; justify-content: space-between; height: 40px; padding: 0 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
.tabs { display: flex; height: 100%; }
.tab { padding: 0 16px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: rgba(255, 255, 255, 0.7); font-size: 14px; font-weight: 600; line-height: 38px; cursor: pointer; }
.tab.active { color: #fff; border-bottom-color: #fff; }
.close { border: 0; background: transparent; padding: 4px; border-radius: 6px; color: #fff; font-size: 16px; line-height: 1; opacity: 0.7; cursor: pointer; transition: opacity 0.15s; }
.close:hover { opacity: 1; }
.panel-body { display: flex; flex-direction: column; padding: 12px; }
.switch-row { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
.switch-row[data-disabled="true"] { opacity: 0.4; }
.switch-label { display: flex; align-items: center; gap: 6px; font-size: 14px; line-height: 24px; }
.info { display: inline-flex; width: 14px; height: 14px; align-items: center; justify-content: center; padding: 0; border: 0; background: transparent; color: rgba(255, 255, 255, 0.5); cursor: pointer; }
.info svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.4; }
/* 对齐 OberonSwitch theme="dark2"：40×20 轨道 + 16×16 白 knob，激活蓝 #0075FF */
.switch { position: relative; width: 40px; height: 20px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; background: #3e3e3e; cursor: pointer; transition: background 0.15s; }
.switch .knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
.switch[data-enabled="true"] { background: #0075ff; }
.switch[data-enabled="true"] .knob { transform: translateX(20px); }
.switch:disabled { cursor: default; }
.reason { margin: 0; color: #ffcc00; font-size: 11px; }
.alert-config-card { border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; padding: 8px 12px; }
.alert-config-row { display: flex; min-height: 35px; align-items: center; justify-content: space-between; padding: 4px 0; }
.alert-config-title { color: #fff; font-size: 14px; font-weight: 600; line-height: 24px; }
.option { display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; color: #fff; font: inherit; font-size: 14px; line-height: 24px; text-align: left; cursor: pointer; }
.option:disabled { color: rgba(255, 255, 255, 0.25); cursor: default; }
/* 对齐 OberonCheckbox theme="dark"：白描边，选中蓝底白勾 #0075FF */
.checkbox { display: inline-flex; width: 14px; height: 14px; align-items: center; justify-content: center; border: 1px solid #fff; border-radius: 2px; background: transparent; color: #fff; }
.checkbox svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; opacity: 0; }
.option[data-checked="true"] .checkbox { border-color: #0075ff; background: #0075ff; }
.option[data-checked="true"] .checkbox svg { opacity: 1; }
.option:disabled .checkbox { border-color: rgba(255, 255, 255, 0.25); }
.option:disabled[data-checked="true"] .checkbox { border-color: rgba(0, 117, 255, 0.3); background: rgba(0, 117, 255, 0.3); }
.tooltip { position: absolute; z-index: 1; visibility: visible; width: max-content; max-width: 280px; padding: 8px 12px; transform: translate(-50%, -100%); border-radius: 4px; background: #3a3a3a; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); color: #fff; font-size: 12px; line-height: 18px; pointer-events: none; }
.tooltip-list { display: flex; flex-direction: column; gap: 8px; }
</style>
