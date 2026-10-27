<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="patrol-form">
    <div class="row">
      <span class="label">
        违停巡逻
        <span class="info-tip" tabindex="0">
          <img class="info-icon" :src="infoIcon" alt="" />
          <span class="info-bubble" role="tooltip">请选择“示教复飞”创建的航线，以确保违停巡逻功能正常使用</span>
        </span>
      </span>
      <button
        type="button"
        class="switch"
        role="switch"
        :aria-checked="enabled"
        :class="{ on: enabled }"
        :disabled="disabled"
        @click="toggle"
      >
        <span class="knob" />
      </button>
    </div>
    <div v-if="enabled" class="delay-row">
      <label class="delay-label" for="patrol-recheck-delay-input">违停复检间隔(分钟)</label>
      <input
        id="patrol-recheck-delay-input"
        class="delay-input"
        :class="{ invalid: delayError }"
        type="text"
        inputmode="numeric"
        :value="delayText"
        :disabled="disabled"
        :aria-invalid="delayError ? 'true' : undefined"
        @input="onDelayInput"
      />
    </div>
    <p v-if="delayError" class="delay-error" role="alert">{{ RECHECK_DELAY_ERROR_MESSAGE }}</p>
    <p v-if="multiWayline" class="hint">多航线任务暂不支持违停巡逻</p>
    <p v-else-if="enabled" class="hint">开启后该任务将按违停巡逻下发，由巡逻机器人接管抓拍过程</p>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import infoIcon from '../../assets/info.svg'
import {
  DEFAULT_RECHECK_DELAY_MINUTES,
  RECHECK_DELAY_ERROR_MESSAGE,
  parseRecheckDelayMinutesInput,
} from './contract'
import type { PatrolFormState, PatrolFormViewClient } from './contract'

const props = defineProps<{
  client: PatrolFormViewClient;
  styleTarget: ShadowRoot | HTMLHeadElement;
  overlayElement: HTMLElement;
}>()

const state = ref<PatrolFormState>({
  enabled: false,
  contextAvailable: false,
  multiWayline: false,
  submitting: false,
  recheckDelayMinutes: DEFAULT_RECHECK_DELAY_MINUTES,
})

let subscription: Disposable | undefined
let disposed = false
onMounted(() => {
  subscription = props.client.state.subscribe((next) => {
    if (!disposed) state.value = next
  })
})
onUnmounted(() => {
  disposed = true
  subscription?.dispose()
})

const enabled = computed(() => state.value.enabled)
const multiWayline = computed(() => state.value.multiWayline)
const disabled = computed(() => multiWayline.value || state.value.submitting)

// 输入框文本本地自持；仅当 Entry 推送的值与当前文本解析结果不一致时同步（复制继承、表单重置），
// 避免用户输入被自身上报的回显覆盖
const delayText = ref(state.value.recheckDelayMinutes === null ? '' : String(state.value.recheckDelayMinutes))
watch(() => state.value.recheckDelayMinutes, (next) => {
  if (parseRecheckDelayMinutesInput(delayText.value) !== next) {
    delayText.value = next === null ? '' : String(next)
  }
})
const delayError = computed(() => enabled.value && parseRecheckDelayMinutesInput(delayText.value) === null)

async function toggle (): Promise<void> {
  if (disabled.value) return
  await props.client.setEnabled({ enabled: !state.value.enabled })
}

function onDelayInput (event: Event): void {
  delayText.value = (event.target as HTMLInputElement).value
  props.client.setRecheckDelayMinutes({ value: parseRecheckDelayMinutesInput(delayText.value) })
}
</script>

<style scoped>
.patrol-form {
  width: 100%;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  line-height: 22px;
  color: #ffffff;
}

.info-tip {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}

.info-tip:focus {
  outline: none;
}

.info-icon {
  width: 16px;
  height: 16px;
  opacity: 0.65;
  transition: opacity 0.2s;
}

.info-tip:hover .info-icon,
.info-tip:focus-visible .info-icon {
  opacity: 1;
}

.info-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  display: none;
  width: max-content;
  max-width: 220px;
  padding: 8px 10px;
  box-sizing: border-box;
  border: 1px solid #393939;
  border-radius: 4px;
  background: #282828;
  font-size: 12px;
  line-height: 18px;
  color: rgba(255, 255, 255, 0.85);
  text-align: left;
  white-space: normal;
  z-index: 10;
}

.info-tip:hover .info-bubble,
.info-tip:focus-visible .info-bubble {
  display: block;
}

.switch {
  position: relative;
  width: 40px;
  height: 20px;
  border-radius: 10px;
  background: #5d5f61;
  padding: 0;
  cursor: pointer;
  transition: background 0.2s;
  border: none;
}

.switch.on {
  background: #0075ff;
  border-color: #0075ff;
}

.switch:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.knob {
  position: absolute;
  top: 3px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #ffffff;
  transition: left 0.2s;
}

.switch.on .knob {
  left: 22px;
}

.delay-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

.delay-label {
  font-size: 14px;
  line-height: 22px;
  color: #ffffff;
}

.delay-input {
  width: 96px;
  height: 26px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid #393939;
  border-radius: 4px;
  background: #1a1a1a;
  font-size: 13px;
  line-height: 24px;
  color: #ffffff;
  text-align: right;
}

.delay-input:focus {
  outline: none;
  border-color: #0075ff;
}

.delay-input.invalid {
  border-color: #ff4d4f;
}

.delay-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.delay-error {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: #ff4d4f;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: rgba(255, 255, 255, 0.45);
}
</style>
