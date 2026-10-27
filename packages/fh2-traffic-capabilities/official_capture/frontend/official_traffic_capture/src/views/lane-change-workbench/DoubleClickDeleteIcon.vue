<!-- Copyright (c) 2026 SZ DJI Technology Co., Ltd. -->
<template>
  <button
    class="dblclick-delete"
    :class="{ active: isActive, disabled: disabled }"
    :disabled="disabled"
    type="button"
    aria-label="删除"
    data-testid="annotation-delete"
    @mousedown.prevent.stop
    @click.stop="onClick"
    @mouseleave="onMouseLeave">
    <!-- 图形迁移自宿主图标库 aec-delete.svg（16px 白色） -->
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M9.5,3.1005859375L9.5,2.3005859375C9.5,2.1901290375,9.41046,2.1005859375,9.3,2.1005859375L6.7,2.1005859375C6.58954,2.1005859375,6.5,2.1901290375,6.5,2.3005859375L6.5,3.1005859375L2.2,3.1005859375Q2.160218,3.1005859375,2.123463,3.1158059375000002Q2.0867091,3.1310359375,2.0585786,3.1591659375Q2.0304482,3.1872959375,2.0152241,3.2240459374999997Q2,3.2608059375,2,3.3005859375L2,4.4005859375Q2,4.4403659375,2.0152241,4.4771259375Q2.0304482,4.5138759375,2.0585786,4.5420059375Q2.0867091,4.5701359375,2.123463,4.585365937500000001Q2.160218,4.6005859375,2.2,4.6005859375L3.6255699999999997,4.6005859375L4.36154,13.3922859375C4.38322,13.6513859375,4.5998199999999997,13.8505859375,4.8598,13.8505859375L11.14021,13.8505859375C11.40018,13.8505859375,11.61678,13.6513859375,11.63846,13.3922859375L12.3744,4.6005859375L13.8,4.6005859375Q13.8398,4.6005859375,13.8765,4.5853659375Q13.9133,4.5701359375,13.9414,4.5420059375Q13.9695,4.5138759375,13.9848,4.4771259375Q14,4.4403659375,14,4.4005859375L14,3.3005859375Q14,3.2608059375,13.9848,3.2240459374999997Q13.9695,3.1872959375,13.9414,3.1591659375Q13.9133,3.1310359375,13.8765,3.1158059375000002Q13.8398,3.1005859375,13.8,3.1005859375L9.5,3.1005859375ZM10.93994,4.6005859375L5.06006,4.6005859375L5.84514,12.3505859375L10.15486,12.3505859375L10.93994,4.6005859375Z"
        fill-rule="evenodd"
        fill="currentColor" />
    </svg>
  </button>
</template>

<script setup lang="ts">
// SPDX-License-Identifier: Apache-2.0
import { ref, watch } from 'vue'

/**
 * 交互迁移自原生 OberonDblclickIcon：两次普通点击确认删除（不是浏览器 dblclick）。
 * 第一次点击进入确认态（红色背景），第二次点击才触发 delete；鼠标移出取消确认。
 * mousedown.prevent.stop 阻止双击选中文字；click.stop 防止事件穿透到直播画面。
 */
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ (e: 'delete'): void }>()

const isActive = ref(false)

watch(() => props.disabled, (disabled) => {
  if (disabled) isActive.value = false
})

function onClick (): void {
  if (props.disabled) return
  if (isActive.value) {
    isActive.value = false
    emit('delete')
    return
  }
  isActive.value = true
}

function onMouseLeave (): void {
  isActive.value = false
}
</script>

<style scoped>
/* 样式迁移自原生 宿主原生双击删除图标样式：4px 内边距热区、4px 圆角、确认态 #e70102 */
.dblclick-delete { display: inline-flex; align-items: center; justify-content: center; padding: 4px; border: 0; border-radius: 4px; background: transparent; color: #fff; cursor: pointer; }
.dblclick-delete.active { background: #e70102; }
.dblclick-delete.disabled { opacity: .25; pointer-events: none; cursor: not-allowed; }
</style>
