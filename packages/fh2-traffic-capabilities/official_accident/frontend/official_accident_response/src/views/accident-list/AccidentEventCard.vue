<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <article class="event-card" :class="{ active }" @click="$emit('select', item.pluginEventId)">
    <div class="event-main">
      <img class="alarm-icon" :src="alarmActivePoint" alt="" />
      <div class="event-info">
        <n-popover
          trigger="manual"
          placement="right"
          :show="coordinateOpen"
          :to="overlayElement"
          :style="{ width: '290px' }"
          @clickoutside="closeCoordinates"
        >
          <template #trigger>
            <button
              type="button"
              class="coordinate-button"
              :class="{ missing: !item.hasCoordinates }"
              :title="item.hasCoordinates ? '查看坐标' : '补录坐标'"
              @click.stop="toggleCoordinates"
            >
              <img class="coordinate-icon" :src="item.hasCoordinates ? latitudeIcon : latitudeMissingIcon" alt="" />
            </button>
          </template>
          <template v-if="item.hasCoordinates">
            <div class="coordinate-value">
              <span>{{ coordinatesText }}</span>
              <n-button text type="primary" @click="copyCoordinates">复制</n-button>
            </div>
          </template>
          <template v-else-if="item.status === 'acknowledged'">
            <strong class="popover-title">经纬度信息缺失</strong>
            <n-input v-model:value="coordinateInput" placeholder="纬度,经度" />
            <small class="coordinate-hint" :class="{ error: coordinateError !== '' }">
              {{ coordinateError || '在地图指定点位右键「获取并复制经纬度」，粘贴到此处' }}
            </small>
            <div class="form-actions">
              <n-button size="small" @click="coordinateOpen = false">取消</n-button>
              <n-button size="small" type="primary" :disabled="!coordinatesValid || busy" @click="submitCoordinates">保存</n-button>
            </div>
          </template>
          <span v-else>签收后可补录经纬度</span>
        </n-popover>

        <strong class="address" :title="item.address || '-'">{{ item.address || '—' }}</strong>
        <div class="event-time">
          <span>报警时间 {{ timeText }}</span>
          <template v-if="expiryHint">
            <i />
            <span class="expiry">{{ expiryHint }}</span>
          </template>
        </div>
      </div>
    </div>

    <footer>
      <n-popover
        v-if="canFeedback"
        trigger="manual"
        placement="right"
        :show="feedbackOpen"
        :to="overlayElement"
        :style="{ width: '290px' }"
        @clickoutside="feedbackOpen = false"
      >
        <template #trigger>
          <n-button text type="primary" @click.stop="toggleFeedback">{{ feedbackButtonText }}</n-button>
        </template>
        <strong class="popover-title">人工反馈</strong>
        <n-input
          v-model:value="feedbackInput"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          :maxlength="300"
          show-count
          placeholder="请输入备注内容（最多 300 字）"
        />
        <div class="form-actions">
          <n-button size="small" @click="feedbackOpen = false">取消</n-button>
          <n-button size="small" type="primary" :disabled="!feedbackValid || busy" :loading="busy" @click="submitFeedback">提交</n-button>
        </div>
      </n-popover>

      <div class="right-actions">
        <n-button
          v-if="item.status === 'acknowledged'"
          size="small"
          :loading="busy"
          :disabled="busy"
          @click.stop="$emit('ignore', item.pluginEventId)"
        >
          忽略
        </n-button>
        <n-tooltip
          v-if="item.status === 'acknowledged' && !item.hasCoordinates"
          :to="overlayElement"
        >
          <template #trigger>
            <span><n-button size="small" type="primary" disabled>立即派遣 ›</n-button></span>
          </template>
          <span data-testid="missing-coordinates-tooltip">经纬度信息缺失</span>
        </n-tooltip>
        <n-button v-else-if="item.status === 'acknowledged'" size="small" type="primary" :loading="busy" :disabled="busy" @click.stop="$emit('handle', item.pluginEventId)">立即派遣 ›</n-button>
        <n-button v-else-if="item.status === 'unacknowledged'" size="small" type="primary" :loading="busy" :disabled="busy" @click.stop="$emit('handle', item.pluginEventId)">签收任务</n-button>
        <span v-else class="terminal-status">{{ terminalStatusText }}</span>
      </div>
    </footer>
  </article>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { NButton, NInput, NPopover, NTooltip } from 'naive-ui'
import { computed, onUnmounted, ref } from 'vue'
import alarmActivePoint from '../../assets/alarm-activepoint.svg'
import latitudeIcon from '../../assets/latitude.svg'
import latitudeMissingIcon from '../../assets/latitude-missing.svg'
import { getExpiryHint, parseCoordinateText } from './contract'
import type { AccidentListItem } from './contract'

const props = defineProps<{
  item: AccidentListItem;
  active: boolean;
  busy: boolean;
  overlayElement: HTMLElement;
}>()

const emit = defineEmits<{
  select: [id: string];
  handle: [id: string];
  ignore: [id: string];
  coordinates: [id: string, lat: number, lng: number];
  feedback: [id: string, note: string];
}>()

const coordinateOpen = ref(false)
const coordinateInput = ref('')
const feedbackOpen = ref(false)
const feedbackInput = ref('')
const now = ref(Date.now())
const timer = window.setInterval(() => { now.value = Date.now() }, 30_000)

const timeText = computed(() => new Date(props.item.occurredAt).toLocaleTimeString('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}))
const coordinatesText = computed(() => {
  const { latitude, longitude } = props.item
  if (latitude === undefined || longitude === undefined) return '—'
  return `${Math.abs(latitude).toFixed(6)} ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(6)} ${longitude >= 0 ? 'E' : 'W'}`
})
const expiryHint = computed(() => getExpiryHint(props.item.status, props.item.occurredAt, now.value))
const feedbackButtonText = computed(() => (props.item.correctionNote ? '修改反馈' : '人工反馈'))
const canFeedback = computed(() => props.item.status === 'acknowledged' || props.item.status === 'handling')
const feedbackValid = computed(() => feedbackInput.value.trim() !== '')
const terminalStatusText = computed(() => {
  switch (props.item.status) {
    case 'handling': return '处置中'
    case 'completed': return '已完成'
    case 'ack_timeout': return '已超时未签收'
    case 'ignored': return '已忽略'
    case 'terminated': return '已终止'
    default: return ''
  }
})

const coordinateParsed = computed(() => parseCoordinateText(coordinateInput.value))
const coordinatesValid = computed(() => coordinateParsed.value !== null)
const coordinateError = computed(() => {
  if (coordinateInput.value.trim() === '') return ''
  return coordinatesValid.value ? '' : '格式或范围不正确，应为「纬度,经度」'
})

function toggleCoordinates (): void {
  coordinateInput.value = ''
  coordinateOpen.value = !coordinateOpen.value
}

function closeCoordinates (): void {
  coordinateOpen.value = false
}

function toggleFeedback (): void {
  feedbackInput.value = props.item.correctionNote ?? ''
  feedbackOpen.value = !feedbackOpen.value
}

function copyText (text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  textarea.remove()
  return copied
}

function copyCoordinates (): void {
  const { latitude, longitude } = props.item
  if (latitude === undefined || longitude === undefined) return
  if (copyText(`${latitude},${longitude}`)) coordinateOpen.value = false
}

function submitCoordinates (): void {
  const parsed = coordinateParsed.value
  if (parsed === null || props.busy) return
  emit('coordinates', props.item.pluginEventId, parsed.lat, parsed.lng)
  coordinateOpen.value = false
}

function submitFeedback (): void {
  const note = feedbackInput.value.trim()
  if (note === '' || props.busy) return
  emit('feedback', props.item.pluginEventId, note)
  feedbackOpen.value = false
}

onUnmounted(() => window.clearInterval(timer))
</script>

<style scoped>
.event-card { flex: 0 0 auto; padding: 12px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: #2a2a2a; color: #fff; cursor: pointer; }
.event-card:hover { background: #323232; }
.event-card.active { border-color: #268aff; }
.event-main { display: flex; gap: 12px; margin-bottom: 12px; }
.alarm-icon { flex: 0 0 40px; width: 40px; height: 40px; }
.event-info { position: relative; flex: 1; min-width: 0; }
.address { display: block; padding-right: 30px; overflow: hidden; line-height: 24px; text-overflow: ellipsis; white-space: nowrap; }
.event-time { display: flex; align-items: center; line-height: 24px; font-size: 13px; }
.event-time i { width: 1px; height: 12px; margin: 0 8px; background: rgba(255,255,255,.3); }
.expiry { color: #ff453a; }
.coordinate-button { position: absolute; top: 0; right: 0; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid #4e4e4e; border-radius: 2px; background: transparent; cursor: pointer; }
.coordinate-button:hover { background: rgba(255,255,255,.08); }
.coordinate-icon { display: block; width: 16px; height: 16px; }
footer, .right-actions, .form-actions, .coordinate-value { display: flex; align-items: center; }
footer { min-height: 28px; justify-content: space-between; }
.right-actions, .form-actions { gap: 8px; }
.form-actions { justify-content: flex-end; margin-top: 12px; }
.coordinate-value { justify-content: space-between; gap: 12px; }
.popover-title { display: block; margin-bottom: 10px; }
.coordinate-hint { display: block; margin-top: 6px; color: #aaa; }
.coordinate-hint.error { color: #ff453a; }
.terminal-status { color: rgba(255,255,255,.55); font-size: 14px; }
.right-actions {
  margin-left: auto;
}
</style>
