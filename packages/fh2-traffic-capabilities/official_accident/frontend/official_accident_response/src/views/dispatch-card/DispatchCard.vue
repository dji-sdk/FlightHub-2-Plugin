<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <PluginViewProvider :style-target="styleTarget">
    <div class="dispatch-card" data-plugin-view="accident-dispatch-card">
      <!-- 优先级指示条：原生插件告警弹窗固定 HIGH（红） -->
      <div class="priority-indicator" :style="{ background: FH2_COLORS.priorityHigh }" />

      <div class="dispatch-card-body">
        <!-- 标题区：等级 tag + 名称 + 关闭 -->
        <div class="card-title">
          <span class="level-tag" :style="{ color: FH2_COLORS.priorityHigh, background: `${FH2_COLORS.priorityHigh}16` }">
            {{ levelText }}
          </span>
          <span class="title-text" :title="state.title">{{ state.title }}</span>
          <button class="close-btn" aria-label="关闭" @click="run(client.close)">×</button>
        </div>

        <!-- 告警内容 -->
        <div class="alarm-content">
          <div class="alarm-address">
            <span class="address-text" :title="state.address || positionText">{{ state.address || positionText }}</span>
          </div>
          <div v-if="state.description" class="alarm-desc">{{ state.description }}</div>
          <div class="alarm-time">{{ occurredAt }}</div>
        </div>

        <!-- 错误提示 -->
        <n-alert v-if="state.error" type="error" class="state-error" :bordered="false">{{ state.error }}</n-alert>

        <!-- 设备选择 -->
        <div class="section-title">
          <b>选择设备</b>
          <button
            class="refresh-btn"
            :disabled="state.loadingDevices"
            title="刷新"
            @click="refreshDevices"
          >
            <img class="refresh-icon" :class="{ spinning: state.loadingDevices }" :src="refreshIcon" alt="刷新" />
          </button>
        </div>
        <n-spin :show="state.loadingDevices" class="device-spin">
          <div v-if="state.devices.length" class="device-list" :class="{ expanded: devicesExpanded }">
            <div
              v-for="device in visibleDevices"
              :key="device.dockSn"
              class="device-card"
              :class="{ selected: state.selectedDockSn === device.dockSn, disabled: device.executingTask }"
              :aria-disabled="device.executingTask"
              :title="device.executingTask ? '设备正在执行任务' : undefined"
              @click="selectDevice(device)"
            >
              <div class="dock-header">
                <span class="dock-model">{{ device.dockModelName }}</span>
                <template v-if="device.dockCallsign">
                  <span class="dock-separator"> | </span>
                  <span class="dock-name">{{ device.dockCallsign }}</span>
                </template>
              </div>
              <div class="card-header">
                <span class="circle-icon" :style="{ background: device.idle ? '#19BE6B' : '#FF9900' }" />
                <span class="device-name">{{ device.droneCallsign }}</span>
              </div>
              <div class="card-main">
                <div v-if="device.distance !== undefined" class="distance-item">
                  <img class="distance-icon" :src="horizontalDistanceIcon" alt="" />
                  <span>{{ distance(device.distance) }}</span>
                </div>
                <div v-if="device.distance !== undefined" class="eta-item">
                  <img class="route-item-icon" :src="waylineTimeIcon" alt="" />
                  <span>{{ duration(estimateArrivalSeconds(device.distance)) }}</span>
                </div>
                <div class="battery-detail">
                  <img class="battery-icon" :src="batteryIcons[battery(device).icon]" alt="电量" />
                  <span :style="{ color: battery(device).textColor }">{{ battery(device).text }}</span>
                  <template v-if="device.remainFlightTime">
                    <span class="battery-segmentation"> | </span>
                    <span class="battery-text" :style="{ color: getRemainFlightTimeColor(device.remainFlightTime) }">{{ formatRemainFlightTime(device.remainFlightTime) }}</span>
                  </template>
                </div>
              </div>
              <div class="card-footer">
                <div class="item-wrapper">
                  <img class="model-icon" :src="droneIcon" alt="" />
                  {{ device.droneModelName }}
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="!state.loadingDevices" class="empty-text">暂无可用设备</div>
        </n-spin>
        <button
          v-if="state.devices.length > COLLAPSED_DEVICE_COUNT"
          type="button"
          class="more-devices-btn"
          :aria-expanded="devicesExpanded"
          @click="devicesExpanded = !devicesExpanded"
        >
          {{ devicesExpanded ? '收起' : '更多设备' }}
          <span class="more-devices-arrow" :class="{ expanded: devicesExpanded }" />
        </button>

        <!-- 推荐路线 -->
        <div class="section-title">
          <b>推荐路线</b>
          <button
            class="refresh-btn"
            :disabled="state.loadingRoutes || state.selectedDockSn === ''"
            title="刷新"
            @click="run(client.refreshRoutes)"
          >
            <img class="refresh-icon" :class="{ spinning: state.loadingRoutes }" :src="refreshIcon" alt="刷新" />
          </button>
        </div>
        <n-spin :show="state.loadingRoutes" description="规划中" class="route-spin">
          <div v-if="state.routes.length" class="route-list">
            <div
              v-for="(route, index) in state.routes"
              :key="route.id"
              class="route-card"
              :class="{ selected: state.selectedRouteIndex === index }"
              @click="run(() => client.selectRoute({ index }))"
            >
              <div class="route-label">{{ route.label }}</div>
              <div class="route-meta">{{ distance(route.totalDistance) }} · {{ duration(route.estimatedDuration) }}</div>
              <div v-if="route.warnings.length" class="route-warnings">{{ route.warnings.join('；') }}</div>
            </div>
          </div>
          <div v-else-if="!state.loadingRoutes" class="empty-text">选择设备后规划路线</div>
        </n-spin>

        <!-- 底部按钮 -->
        <div class="footer-actions">
          <template v-if="state.status === 'pending'">
            <n-button class="action-btn cancel-btn" ghost color="#E70102" @click="run(client.cancelDispatch)">
              取消派遣
            </n-button>
            <n-button
              class="action-btn"
              type="primary"
              :disabled="!canDispatch"
              :loading="state.dispatching"
              @click="run(client.dispatch)"
            >
              立即派遣
            </n-button>
          </template>
          <template v-else-if="state.status === 'dispatched'">
            <n-button class="action-btn" type="tertiary" @click="run(client.viewDetail)">查看详情</n-button>
          </template>
        </div>

        <n-button v-if="state.enableMultiAngle" secondary type="primary" block class="multi-angle-btn">多视角处置</n-button>
      </div>
    </div>
  </PluginViewProvider>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NAlert, NButton, NSpin } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import batteryLevelLow from '../../assets/battery-level-low.svg'
import batteryLevelMiddle from '../../assets/battery-level-middle.svg'
import batteryLevelHigh from '../../assets/battery-level-high.svg'
import batteryLevelFull from '../../assets/battery-level-full.svg'
import batteryCharging from '../../assets/battery-charging.svg'
import batteryUnknown from '../../assets/battery-unknown.svg'
import refreshIcon from '../../assets/refresh.svg'
import droneIcon from '../../assets/drone.svg'
import horizontalDistanceIcon from '../../assets/horizontal-distance.svg'
import waylineTimeIcon from '../../assets/wayline-time.svg'
import type { DispatchDevice } from '../../workflow/types'
import PluginViewProvider from '../shared/PluginViewProvider.vue'
import { FH2_COLORS } from '../shared/theme'
import { formatDistance, formatDuration } from '../shared/route-format'
import {
  COLLAPSED_DEVICE_COUNT,
  estimateArrivalSeconds,
  formatRemainFlightTime,
  getDeviceBatteryDisplay,
  getRemainFlightTimeColor,
  getVisibleDispatchDevices,
  isDispatchAvailable,
} from './contract'
import type { DeviceBatteryIcon, DispatchCardState, DispatchCardViewClient } from './contract'

const props = defineProps<{
  client: DispatchCardViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>()
const state = shallowRef<DispatchCardState>({
  popupId: '', pluginEventId: '', title: '事故快处', receivedAt: 0,
  enableMultiAngle: false, status: 'idle', projectId: '', organizationId: '', alarmPosition: null,
  requiresRoute: false, devices: [], selectedDockSn: '',
  routes: [], selectedRouteIndex: -1, loadingDevices: false, loadingRoutes: false,
  dispatching: false, error: null, level: 1, address: '', description: '', waitTime: 0,
})

const levelText = computed(() => `${state.value.level}级`)
const occurredAt = computed(() => new Date(state.value.receivedAt).toLocaleString('zh-CN', { hour12: false }))
const positionText = computed(() => {
  const position = state.value.alarmPosition
  if (!position) return ''
  return `${position.lng.toFixed(6)}, ${position.lat.toFixed(6)}`
})
const canDispatch = computed(() => isDispatchAvailable(state.value))
const devicesExpanded = ref(false)
const visibleDevices = computed(() => getVisibleDispatchDevices(state.value.devices, devicesExpanded.value))

const batteryIcons: Record<DeviceBatteryIcon, string> = {
  'battery-level-low': batteryLevelLow,
  'battery-level-middle': batteryLevelMiddle,
  'battery-level-high': batteryLevelHigh,
  'battery-level-full': batteryLevelFull,
  'battery-charging': batteryCharging,
  'battery-unknown': batteryUnknown,
}

function battery (device: DispatchDevice) {
  return getDeviceBatteryDisplay(device)
}

// 对齐原生 measureBasicUnitTransfer(Length, floor, 1 位小数)：>10000m 转 km。
function distance (meters: number): string {
  return formatDistance(meters)
}

function duration (seconds: number): string {
  return formatDuration(seconds)
}

function refreshDevices (): void {
  devicesExpanded.value = false
  void run(client.refreshDevices)
}

function selectDevice (device: DispatchDevice): void {
  if (device.executingTask) return
  void run(() => client.selectDevice({ dockSn: device.dockSn }))
}

async function run (action: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch {
    // Entry 会把业务失败写入共享 state。
  }
}

let subscription: Disposable | undefined
onMounted(() => { subscription = props.client.state.subscribe(value => { state.value = value }) })
onUnmounted(() => subscription?.dispose())
const client = props.client
</script>

<style scoped>
.dispatch-card {
  display: flex;
  width: 343px;
  max-height: calc(100vh - 160px);
  overflow: hidden;
  border-radius: 8px;
  background: #2A2A2A;
  color: rgba(255, 255, 255, 1);
  font-size: 14px;
  line-height: 24px;
}
.priority-indicator {
  width: 8px;
  flex-shrink: 0;
}
.dispatch-card-body {
  flex: 1;
  min-width: 0;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  overflow-y: auto;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.level-tag {
  height: 24px;
  padding: 0 12px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
  flex-shrink: 0;
}
.title-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close-btn {
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 1);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}
.alarm-content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
}
.alarm-address {
  display: flex;
  align-items: center;
  gap: 4px;
}
.address-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alarm-desc {
  overflow: hidden;
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alarm-time {
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
}
.state-error {
  margin-bottom: 12px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 8px;
  font-size: 14px;
}
.section-title b {
  font-weight: 600;
}
.refresh-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
.refresh-icon {
  display: block;
  width: 16px;
  height: 16px;
}
.refresh-icon.spinning {
  animation: refresh-spin 2s linear infinite;
}
@keyframes refresh-spin {
  0% {
    transform: rotate(0deg);
  }
  50% {
    transform: rotate(180deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
.device-spin, .route-spin {
  min-height: 60px;
}
.device-list, .route-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}
/* 折叠态（≤3 台）不限高，避免卡片高于原生时误出滚动条；展开态恢复 40vh 滚动。 */
.device-list.expanded {
  max-height: 40vh;
}
.route-list {
  max-height: 240px;
}
.more-devices-btn {
  display: flex;
  align-items: center;
  width: fit-content;
  margin-top: 8px;
  padding: 0;
  gap: 6px;
  border: 0;
  background: transparent;
  color: #268AFF;
  cursor: pointer;
  font: inherit;
  line-height: 24px;
}
.more-devices-arrow {
  width: 7px;
  height: 7px;
  border-right: 1px solid currentColor;
  border-bottom: 1px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
  transition: transform 0.2s ease;
}
.more-devices-arrow.expanded {
  transform: translateY(2px) rotate(225deg);
}
.route-card {
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
}
.route-card:hover {
  background: rgba(255, 255, 255, 0.06);
}
.route-card.selected {
  border-color: rgba(0, 117, 255, 1);
  background: rgba(0, 117, 255, 0.1);
}
.device-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 126px;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  cursor: pointer;
}
.device-card.selected {
  border-color: rgba(0, 117, 255, 1);
  box-shadow: 0 0 0 1px rgba(0, 117, 255, 1);
}
.device-card.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.device-card.disabled.selected {
  border-color: rgba(255, 255, 255, 0.15);
  box-shadow: none;
}
.dock-header {
  display: flex;
  align-items: center;
  height: 36px;
  margin: -8px -8px 4px;
  padding: 0 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px 6px 0 0;
  background: #3E3E3E;
  font-size: 14px;
  font-weight: 400;
  line-height: 16px;
}
.dock-model {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
}
.dock-separator {
  margin: 0 6px;
  color: rgba(79, 79, 79, 1);
}
.dock-name {
  color: rgba(255, 255, 255, 1);
}
.device-card .card-header {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 20px;
  margin-top: 8px;
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}
.circle-icon {
  display: inline-block;
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin-left: 4px;
  border-radius: 50%;
}
.device-card .device-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.device-card .card-main {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  height: 16px;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}
.distance-item {
  display: flex;
  align-items: center;
}
.distance-icon {
  display: block;
  width: 16px;
  height: 16px;
  margin-right: 4px;
}
.eta-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.battery-detail {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
}
.battery-icon {
  display: block;
  flex-shrink: 0;
}
.battery-segmentation {
  color: rgba(255, 255, 255, 0.3);
}
.battery-text {
  flex-shrink: 0;
  white-space: nowrap;
}
.device-card .card-footer {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 4px;
  height: 20px;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  color: rgba(255, 255, 255, 0.45);
}
.card-footer .item-wrapper {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  min-width: 60px;
  height: 22px;
  box-sizing: border-box;
  padding: 2px 4px;
  gap: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: #2A2A2A;
  line-height: 16px;
  color: rgba(255, 255, 255, 0.7);
}
.model-icon {
  display: block;
  width: 14px;
  height: 14px;
}
.route-item-icon {
  display: block;
  width: 12px;
  height: 12px;
}
.route-label {
  font-weight: 600;
}
.route-meta {
  color: rgba(255, 255, 255, 0.5);
  font-size: 12px;
}
.route-warnings {
  margin-top: 2px;
  color: rgba(250, 173, 20, 1);
  font-size: 12px;
  line-height: 18px;
}
.empty-text {
  padding: 16px 0;
  color: rgba(255, 255, 255, 0.25);
  font-size: 12px;
  text-align: center;
}
.footer-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.action-btn {
  flex: 1;
  font-weight: 600;
}
.multi-angle-btn {
  margin-top: 8px;
}
</style>
