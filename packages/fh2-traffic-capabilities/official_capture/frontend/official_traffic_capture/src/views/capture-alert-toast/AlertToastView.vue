<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <div class="capture-alert-toast-layer" data-plugin-view="capture-alert-toast">
    <Transition name="capture-alert-toast">
      <button v-if="state.visible"
              class="capture-alert-toast"
              type="button"
              data-testid="capture-alert-toast"
              @click="click">
        <svg class="toast-icon" viewBox="0 0 8 8" width="16" height="16" aria-hidden="true">
          <path fill="#ff9900" fill-rule="evenodd" d="M8 4.5q0 .172-.017.343-.017.171-.05.34-.034.168-.084.333t-.115.323q-.066.16-.147.31-.081.153-.177.295-.095.143-.204.276-.11.133-.231.255-.122.121-.255.23-.133.11-.276.205-.142.096-.294.177-.152.08-.31.147-.16.065-.324.115-.165.05-.333.084-.169.033-.34.05T4.5 8q-.172 0-.343-.017-.171-.017-.34-.05-.168-.034-.333-.084t-.323-.115q-.16-.066-.31-.147-.153-.081-.295-.177-.143-.095-.276-.204-.133-.11-.255-.231-.121-.122-.23-.255-.11-.133-.205-.276-.096-.142-.177-.294-.08-.152-.147-.31-.065-.16-.115-.324-.05-.165-.084-.333-.033-.169-.05-.34T1 4.5q0-.172.017-.343.017-.171.05-.34.034-.168.084-.333t.115-.323q.066-.16.147-.31.081-.153.177-.295.095-.143.204-.276.11-.133.231-.255.122-.121.255-.23.133-.11.276-.205.142-.096.294-.177.152-.08.31-.147.16-.065.324-.115.165-.05.333-.084.169-.033.34-.05T4.5 1q.172 0 .343.017.171.017.34.05.168.034.333.084t.323.115q.16.066.31.147.153.081.295.177.143.095.276.204.133.11.255.231.121.122.23.255.11.133.205.276.096.142.177.294.08.152.147.31.065.16.115.324.05.165.084.333.033.169.05.34T8 4.5zm-3.875.88v-3h.75v3h-.75zm0 .49v.75h.75v-.75h-.75z" />
        </svg>
        <span class="content">{{ state.message }}</span>
        <svg class="toast-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path fill="rgba(0, 0, 0, 0.45)" fill-rule="evenodd" d="M11.646 7.646a.5.5 0 0 1 0 .708l-.707.707-4.454 4.454a.2.2 0 0 1-.283 0l-.778-.777a.2.2 0 0 1 0-.283L9.879 8 5.424 3.545a.2.2 0 0 1 0-.283l.778-.777a.2.2 0 0 1 .283 0l4.454 4.454.707.707z" />
        </svg>
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { onMounted, onUnmounted, shallowRef } from 'vue'
import type { Disposable } from 'fh2-plugin-sdk'
import type { CaptureAlertToastClient } from './contract'

/**
 * 「发现目标」告警 Toast（live overlay 顶部居中）。样式对齐原生
 * AutoCaptureAlertToast：白底 + 2px #FF9900 描边圆角卡 + warning/箭头图标 + 进出场过渡。
 * 图标取自 宿主图标库 sprite（action-position-warning / aec-arrow-right，单色
 * currentColor 语义改为内联 fill）；外层 layer 恒驻但 pointer-events: none，不拦截直播点击。
 */
const props = defineProps<{ client: CaptureAlertToastClient }>()
const state = shallowRef<{ visible: boolean; message: string }>({ visible: false, message: '发现目标' })
let subscription: Disposable | undefined

onMounted(() => {
  subscription = props.client.state.subscribe(value => {
    state.value = value
  })
})
onUnmounted(() => subscription?.dispose())

function click (): void {
  props.client.click()
}
</script>

<style scoped>
* { box-sizing: border-box; }
.capture-alert-toast-layer { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; pointer-events: none; }
.capture-alert-toast { display: inline-flex; flex-shrink: 0; gap: 8px; align-items: center; padding: 10px; border: 2px solid #ff9900; border-radius: 6px; background: #fff; color: rgba(0, 0, 0, 0.65); font-family: "Open Sans", "PingFang SC", "Microsoft YaHei", sans-serif; cursor: pointer; user-select: none; pointer-events: auto; }
.toast-icon { flex-shrink: 0; display: block; }
.content { white-space: nowrap; font-size: 14px; line-height: 22px; }

/* 对齐原生 capture-toast 过渡：opacity + translateY(-10px)，0.3s */
.capture-alert-toast-enter-active,
.capture-alert-toast-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.capture-alert-toast-enter-from,
.capture-alert-toast-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
